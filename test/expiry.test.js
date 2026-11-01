import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETENTION_MS } from '../src/app.js';
import { DAY, T0, newDevice, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

// Built at runtime: shaped like a random secret, but not one.
const SECRET = ['cron', 'Q7w'.repeat(11)].join('-');

/** A case with child rows in every table, so the job must remove more than the case row. */
async function busyCase(t, fields) {
  const filed = await t.fileCase(fields);
  await t.answer(filed.summonsToken);
  await t.vote(filed.juryToken, { vote: 'guilty', comment: 'Obviously guilty.' }, newDevice());
  const { clickId } = await (await t.unlock(filed.caseId)).json();
  await t.unlockEmail(filed.caseId, { clickId, email: 'juror@example.com' });
  return filed;
}

async function expectGone(t, filed) {
  for (const path of [
    `/cases/${filed.caseId}`,
    `/cases/${filed.caseId}/card.png`,
    `/summons/${filed.summonsToken}`,
    `/jury/${filed.juryToken}`,
    `/plaintiff/${filed.plaintiffToken}`,
  ]) {
    expect((await t.get(path)).status, path).toBe(404);
  }
  expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
}

describe('M3 exit criterion: the expiry job removes cases older than 30 days (faked clock)', () => {
  it('removes a case filed more than 30 days ago with all its rows, and keeps a younger one', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup();
    const old = await busyCase(t, { title: 'Filed on day 0' });
    t.advance(10 * DAY);
    const young = await busyCase(t, { title: 'Filed on day 10' });
    // A report on the old case adds a reports row too.
    expect((await t.report(old.caseId)).status).toBe(201);
    expect(await db.rowsFor(old.caseId)).toEqual({ cases: 1, votes: 1, reports: 1, unlock_clicks: 1 });

    // Day 30 exactly: nothing is older than 30 days yet.
    t.clock.now = new Date(T0.getTime() + 30 * DAY);
    let res = await t.expire();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0, cutoff: T0.toISOString() });
    expect(await db.rowsFor(old.caseId)).toMatchObject({ cases: 1 });

    // One millisecond later the day-0 case goes, everywhere, and the day-10 case stays.
    t.advance(1);
    res = await t.expire();
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);
    await expectGone(t, old);
    expect((await t.get(`/cases/${young.caseId}`)).status).toBe(200);
    expect(await db.rowsFor(young.caseId)).toEqual({ cases: 1, votes: 1, reports: 0, unlock_clicks: 1 });

    // Running again deletes nothing new.
    expect((await (await t.expire()).json()).deleted).toBe(0);

    // Day 40 + 1 ms: the day-10 case goes too.
    t.clock.now = new Date(T0.getTime() + 40 * DAY + 1);
    expect((await (await t.expire()).json()).deleted).toBe(1);
    await expectGone(t, young);
  });

  it('is 30 days', () => {
    expect(RETENTION_MS).toBe(30 * DAY);
  });

  it('keeps the promise the pages make, given the daily cron time in vercel.json', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup();
    const filed = await t.fileCase(); // T0 is 12:00 UTC on 2026-11-01
    for (const path of [`/cases/${filed.caseId}`, `/plaintiff/${filed.plaintiffToken}`, `/summons/${filed.summonsToken}`]) {
      expect(await (await t.get(path)).text(), path).toContain('on 2026-12-01 or the day after');
    }
    const [{ schedule }] = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).crons;
    const [minute, hour] = schedule.split(' ').map(Number);
    const cronOn = (day) => new Date(Date.UTC(2026, 11, day, hour, minute));
    // The run on 1 December comes before the case turns 30 days old; the run on 2 December deletes it.
    t.clock.now = cronOn(1);
    expect((await (await t.expire()).json()).deleted).toBe(0);
    t.clock.now = cronOn(2);
    expect((await (await t.expire()).json()).deleted).toBe(1);
  });

  it('deletes ruled, declined, answered and taken-down cases alike', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup();
    const ruled = await t.ruledCase();
    const answered = await t.fileCase();
    await t.answer(answered.summonsToken);
    const reported = await t.fileCase();
    await t.report(reported.caseId);
    const declining = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const declined = await declining.fileCase();
    await declining.answer(declined.summonsToken);
    expect((await declining.post(`/cases/${declined.caseId}/rule`)).status).toBe(422);

    t.advance(31 * DAY);
    expect((await (await t.expire()).json()).deleted).toBe(4);
    for (const filed of [ruled, answered, reported, declined]) await expectGone(t, filed);
  });

  it('works through the backlog in batches', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup();
    const filed = [];
    for (let i = 0; i < 5; i += 1) filed.push(await t.fileCase({ title: `Old case ${i}` }));
    t.advance(31 * DAY);
    const keep = await t.fileCase({ title: 'Fresh case' });

    const ids = await db.store.deleteFiledBefore(new Date(t.clock.now.getTime() - RETENTION_MS), { batchSize: 2 });
    expect(ids.sort()).toEqual(filed.map((f) => f.caseId).sort());
    expect((await db.sql('SELECT id FROM cases')).map((r) => r.id)).toEqual([keep.caseId]);
  });

  it('drops expired cards from the per-instance cache', async () => {
    await db.sql('DELETE FROM cases');
    const cardCache = new Map();
    const t = db.setup({ cardCache, renderCard: async () => new Uint8Array([1]) });
    const filed = await t.fileCase();
    await t.get(`/cases/${filed.caseId}/card.png`);
    expect(cardCache.has(filed.caseId)).toBe(true);
    t.advance(31 * DAY);
    await t.expire();
    expect(cardCache.has(filed.caseId)).toBe(false);
  });
});

describe('who can run the job', () => {
  it('with CRON_SECRET set, only a request carrying it as a bearer token runs the job', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup({ cronSecret: SECRET });
    const filed = await t.fileCase();
    t.advance(31 * DAY);

    for (const attempt of [undefined, '', 'wrong', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const res = await t.expire(attempt);
      expect(res.status, String(attempt)).toBe(401);
      expect(await res.text()).not.toContain(SECRET);
    }
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 1 });

    const res = await t.expire(SECRET);
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);
  });

  it('without CRON_SECRET it still runs: it only enforces the retention policy, from the server clock', async () => {
    await db.sql('DELETE FROM cases');
    const t = db.setup();
    const filed = await t.fileCase();
    // Nothing a caller sends can move the cutoff.
    const early = await t.get('/cron/expire?cutoff=2099-01-01&now=2099-01-01');
    expect((await early.json()).deleted).toBe(0);
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 1 });
    t.advance(31 * DAY);
    expect((await (await t.expire()).json()).deleted).toBe(1);
  });

  it('answers no-store', async () => {
    const t = db.setup();
    expect((await t.expire()).headers.get('cache-control')).toBe('no-store');
  });
});

describe('vercel.json', () => {
  it('runs /cron/expire once a day, which is what Vercel Hobby allows', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(config.crons).toHaveLength(1);
    const [cron] = config.crons;
    expect(cron.path).toBe('/cron/expire');
    const [minute, hour, ...rest] = cron.schedule.split(' ');
    // Fixed minute and hour, every day: anything more frequent fails a Hobby deploy.
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
    expect(rest).toEqual(['*', '*', '*']);
    // Nothing else in vercel.json, so Vercel's zero-config Hono detection is untouched.
    expect(Object.keys(config).filter((k) => k !== '$schema')).toEqual(['crons']);
  });
});
