import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECLINE_MESSAGE, screen } from '../src/scope.js';
import { T0, testDatabase } from './helpers.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/out-of-scope.json', import.meta.url), 'utf8'));
const { inScope, ...outOfScope } = fixtures;
const outOfScopeCases = Object.entries(outOfScope).flatMap(([category, phrases]) =>
  phrases.map((phrase) => [category, phrase]),
);

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

async function counts() {
  const [row] = await db.sql('SELECT count(*)::int AS cases, count(ruling)::int AS rulings FROM cases');
  return row;
}

describe('out-of-scope filings', () => {
  it('a charge of "my boyfriend hits me" returns 422 with the decline message and stores no case or ruling', async () => {
    const t = db.setup();
    const before = await counts();
    const res = await t.post('/cases', { charge: 'my boyfriend hits me', testimony: 'It happened again on Friday.' });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe(DECLINE_MESSAGE);
    expect(body.declined).toBe(true);
    expect(await counts()).toEqual(before);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('the decline message says why and points to real help', () => {
    expect(DECLINE_MESSAGE).toMatch(/petty/i);
    expect(DECLINE_MESSAGE).toMatch(/abuse/i);
    expect(DECLINE_MESSAGE).toMatch(/health/i);
    expect(DECLINE_MESSAGE).toMatch(/money/i);
    expect(DECLINE_MESSAGE).toMatch(/minors/i);
    expect(DECLINE_MESSAGE).toMatch(/emergency/i);
  });

  it.each(outOfScopeCases)('declines a %s charge: "%s"', async (_category, phrase) => {
    const t = db.setup();
    const before = await counts();
    const res = await t.post('/cases', { charge: phrase, testimony: 'Your honour, hear me out.' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(DECLINE_MESSAGE);
    expect(await counts()).toEqual(before);
  });

  it.each(outOfScopeCases)('declines %s terms hidden in the plaintiff testimony: "%s"', async (_category, phrase) => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: 'Was rude at dinner', testimony: `Context: ${phrase}. Anyway.` });
    expect(res.status).toBe(422);
  });

  it('declines out-of-scope terms in the title, in any letter case', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { title: 'MY BOYFRIEND HITS ME', charge: 'Was rude', testimony: 'Very rude.' });
    expect(res.status).toBe(422);
  });

  it.each(inScope)('accepts a petty case: "%s"', async (phrase) => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: phrase, testimony: `${phrase}. I rest my case.` });
    expect(res.status).toBe(201);
  });
});

describe('out-of-scope defendant testimony', () => {
  it('returns 422 with the decline message and stores nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.answer(filed.summonsToken, 'Honestly my girlfriend hit me first.');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(DECLINE_MESSAGE);
    const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.defendant_testimony).toBeNull();
  });
});

describe('the pre-ruling screen', () => {
  it('declines a stored case that contains out-of-scope terms with 422, no ruling and no judge call', async () => {
    const t = db.setup();
    // A case filed before a term joined the list: write it straight to the store, bypassing the filing screen.
    const id = 'legacyCase000001';
    await db.store.createCase({
      id,
      summonsToken: 'S'.repeat(32),
      juryToken: 'J'.repeat(32),
      title: 'Old case',
      charge: 'Was rude at dinner',
      plaintiffTestimony: 'He said my boyfriend hits me as a joke and nobody laughed.',
      createdAt: T0,
      deadlineAt: new Date(T0.getTime() - 1000),
    });

    const res = await t.post(`/cases/${id}/rule`);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(DECLINE_MESSAGE);
    expect(t.judge).not.toHaveBeenCalled();
    const [row] = await db.sql('SELECT ruling, declined_at FROM cases WHERE id = $1', [id]);
    expect(row.ruling).toBeNull();
    expect(row.declined_at).not.toBeNull();
  });
});

describe('screen()', () => {
  it('reports the category of the first match', () => {
    expect(screen('my boyfriend hits me')).toEqual({ outOfScope: true, category: 'abuse' });
    expect(screen('fine', 'my mum has cancer')).toEqual({ outOfScope: true, category: 'health' });
    expect(screen('he owes me $500')).toEqual({ outOfScope: true, category: 'money' });
    expect(screen('my son broke curfew')).toEqual({ outOfScope: true, category: 'minors' });
  });

  it('passes petty text and ignores null or missing values', () => {
    expect(screen('He ate my fries', null, undefined)).toEqual({ outOfScope: false });
  });

  it('is not fooled by extra spaces, line breaks or full-width letters', () => {
    expect(screen('my boyfriend\n  hits   me').outOfScope).toBe(true);
    expect(screen('ｃａｎｃｅｒ').outOfScope).toBe(true);
  });
});
