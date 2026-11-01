import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, T0, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const CHARGE = 'Said "five minutes away" while still in the shower';
const TESTIMONY = 'I waited forty minutes outside the cinema and missed the trailers.';

async function countCases() {
  const [row] = await db.sql('SELECT count(*)::int AS n FROM cases');
  return row.n;
}

describe('POST /cases', () => {
  it('returns 201 with a case id and two distinct tokens of at least 24 characters', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: CHARGE, testimony: TESTIMONY });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.caseId).toBe('string');
    expect(body.caseId.length).toBeGreaterThanOrEqual(16);
    expect(body.summonsToken.length).toBeGreaterThanOrEqual(24);
    expect(body.juryToken.length).toBeGreaterThanOrEqual(24);
    expect(body.summonsToken).not.toBe(body.juryToken);
    expect(new Set([body.caseId, body.summonsToken, body.juryToken]).size).toBe(3);
    for (const value of [body.caseId, body.summonsToken, body.juryToken]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('returns share links and a 24-hour deadline', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: CHARGE, testimony: TESTIMONY });
    const body = await res.json();

    expect(body.summonsUrl).toBe(`http://localhost/summons/${body.summonsToken}`);
    expect(body.caseUrl).toBe(`http://localhost/cases/${body.caseId}`);
    expect(new Date(body.deadlineAt).getTime()).toBe(T0.getTime() + 24 * HOUR);
  });

  it('stores the case with the charge, testimony and both tokens', async () => {
    const t = db.setup();
    const body = await (await t.post('/cases', { title: 'The Shower Affair', charge: CHARGE, testimony: TESTIMONY })).json();

    const [row] = await db.sql('SELECT * FROM cases WHERE id = $1', [body.caseId]);
    expect(row.title).toBe('The Shower Affair');
    expect(row.charge).toBe(CHARGE);
    expect(row.plaintiff_testimony).toBe(TESTIMONY);
    expect(row.summons_token).toBe(body.summonsToken);
    expect(row.jury_token).toBe(body.juryToken);
    expect(row.defendant_testimony).toBeNull();
    expect(row.ruling).toBeNull();

    const page = await t.get(`/cases/${body.caseId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('The Shower Affair');
  });

  it('defaults the title to the charge and trims whitespace', async () => {
    const t = db.setup();
    const body = await (await t.post('/cases', { charge: `  ${CHARGE}  `, testimony: `\n${TESTIMONY}\n` })).json();
    const [row] = await db.sql('SELECT title, charge, plaintiff_testimony FROM cases WHERE id = $1', [body.caseId]);
    expect(row.title).toBe(CHARGE);
    expect(row.charge).toBe(CHARGE);
    expect(row.plaintiff_testimony).toBe(TESTIMONY);
  });

  it('never repeats a token or id across many cases', async () => {
    const t = db.setup();
    const values = [];
    for (let i = 0; i < 25; i++) {
      const body = await (await t.post('/cases', { charge: `${CHARGE} #${i}`, testimony: TESTIMONY })).json();
      values.push(body.caseId, body.summonsToken, body.juryToken);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it.each([
    ['missing charge', { testimony: TESTIMONY }, /charge/],
    ['missing testimony', { charge: CHARGE }, /testimony/],
    ['blank charge', { charge: '   ', testimony: TESTIMONY }, /charge/],
    ['blank testimony', { charge: CHARGE, testimony: '\n\t ' }, /testimony/],
    ['charge over 280 characters', { charge: 'x'.repeat(281), testimony: TESTIMONY }, /charge/],
    ['testimony over 2000 characters', { charge: CHARGE, testimony: 'x'.repeat(2001) }, /testimony/],
    ['title over 120 characters', { title: 'x'.repeat(121), charge: CHARGE, testimony: TESTIMONY }, /title/],
    ['non-string charge', { charge: 42, testimony: TESTIMONY }, /charge/],
    ['non-string title', { title: ['a'], charge: CHARGE, testimony: TESTIMONY }, /title/],
  ])('rejects %s with 400 and stores nothing', async (_name, payload, message) => {
    const t = db.setup();
    const before = await countCases();
    const res = await t.post('/cases', payload);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(await countCases()).toBe(before);
  });

  it('accepts fields at exactly their maximum length', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { title: 't'.repeat(120), charge: 'c'.repeat(280), testimony: 'p'.repeat(2000) });
    expect(res.status).toBe(201);
  });

  it('rejects invalid JSON with 400', async () => {
    const t = db.setup();
    const res = await t.post('/cases', '{"charge": "oops"');
    expect(res.status).toBe(400);
  });

  it('rejects a JSON array body with 400', async () => {
    const t = db.setup();
    const res = await t.post('/cases', '[1, 2]');
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const t = db.setup();
    const res = await t.request('/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'charge=a&testimony=b',
    });
    expect(res.status).toBe(415);
  });

  it('rejects a body over 16 KB with 413 and stores nothing', async () => {
    const t = db.setup();
    const before = await countCases();
    const res = await t.post('/cases', { charge: CHARGE, testimony: TESTIMONY, padding: 'x'.repeat(17 * 1024) });
    expect(res.status).toBe(413);
    expect(await countCases()).toBe(before);
  });
});
