// M5 exit criterion 6: the safety review. The PRD's bar is zero published cases that name someone outside
// the argument or fall into the excluded topics, checked on every ruling (until 100 are reviewed). Every
// ruling waits in a queue; a violation takes the case down; an unreviewed ruling keeps "continue" away.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_SAMPLE, decide } from '../src/decide.js';
import { REVIEW_RESULTS } from '../src/store.js';
import { DAY, testDatabase } from './helpers.js';
import { paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
beforeEach(async () => {
  await db.sql('DELETE FROM cases');
  await db.sql('DELETE FROM case_outcomes');
});

const queueIds = async (options) => (await db.store.reviewQueue(options)).map((item) => item.id);
const safety = async () => {
  const { rulings, reviewed, violations, pending, missed } = await db.store.outcomeTotals();
  return { rulings, reviewed, violations, pending, missed };
};

describe('M5 exit criterion 6: every ruling waits for a safety review', () => {
  it('the queue holds ruled, unreviewed cases, oldest first, with what the reviewer needs to read', async () => {
    const t = db.setup();
    await t.fileCase({ title: 'Not ruled yet' });
    const first = await t.ruledCase({ title: 'First ruling' });
    t.advance(60_000);
    const second = await t.ruledCase({ title: 'Second ruling' });
    expect(await queueIds()).toEqual([first.caseId, second.caseId]);

    const [item] = await db.store.reviewQueue();
    expect(item).toMatchObject({
      id: first.caseId,
      title: 'First ruling',
      charge: expect.stringContaining('five minutes'),
      verdict: 'split',
      ruling: expect.stringContaining('Order in the group chat'),
      appealVerdict: null,
      appealRuling: null,
      takenDown: false,
    });
    expect(item.createdAt).toBeInstanceOf(Date);
    expect(await safety()).toEqual({ rulings: 2, reviewed: 0, violations: 0, pending: 2, missed: 0 });
  });

  it('"ok" takes a ruling off the queue and counts it as reviewed', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: false })).toEqual({ ok: true });
    expect(await queueIds()).toEqual([]);
    expect(await safety()).toEqual({ rulings: 1, reviewed: 1, violations: 0, pending: 0, missed: 0 });
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
  });

  it('a violation takes the case down at once, with a report row that says why, and turns the safety bar red', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    expect(REVIEW_RESULTS).toEqual(['ok', 'names_someone', 'serious']);
    expect(await db.store.reviewRuling(filed.caseId, { result: 'names_someone' })).toEqual({ ok: true });
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(410);
    expect((await t.get(`/cases/${filed.caseId}/card.png`)).status).toBe(404);
    expect(await db.sql('SELECT reason, note FROM reports WHERE case_id = $1', [filed.caseId])).toEqual([
      { reason: 'names_someone', note: expect.stringMatching(/safety review/i) },
    ]);
    expect(await safety()).toEqual({ rulings: 1, reviewed: 1, violations: 1, pending: 0, missed: 0 });

    // Reviewing it again (say, "serious" after all) changes the result but never adds a second report.
    expect(await db.store.reviewRuling(filed.caseId, { result: 'serious' })).toEqual({ ok: true });
    expect(await db.sql('SELECT count(*)::int AS n FROM reports WHERE case_id = $1', [filed.caseId])).toEqual([{ n: 1 }]);
    expect((await db.store.outcomeTotals()).violations).toBe(1);
  });

  it('a case already taken down by a user report still needs its ruling reviewed, and keeps its one report', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    await t.report(filed.caseId, { reason: 'mean' });
    expect(await db.store.reviewQueue()).toEqual([expect.objectContaining({ id: filed.caseId, takenDown: true })]);
    expect(await db.store.reviewRuling(filed.caseId, { result: 'serious' })).toEqual({ ok: true });
    expect(await db.sql('SELECT reason FROM reports WHERE case_id = $1', [filed.caseId])).toEqual([{ reason: 'mean' }]);
  });

  it('an appeal ruling after the review puts the case back in the queue', async () => {
    const t = paidMode(db);
    const filed = await t.paidCase();
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: false })).toEqual({ ok: true });
    expect(await queueIds()).toEqual([]);

    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(201);
    expect(await db.store.reviewQueue()).toEqual([
      expect.objectContaining({ id: filed.caseId, appealVerdict: 'split', appealRuling: expect.stringContaining('Order in the group chat') }),
    ]);
    expect(await safety()).toMatchObject({ reviewed: 0, pending: 1 });

    // "ok" for the ruling the reviewer read earlier doesn't approve the appeal ruling they haven't.
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: false })).toEqual({ ok: false, why: 'has_appeal' });
    expect(await queueIds()).toEqual([filed.caseId]);
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: true })).toEqual({ ok: true });
    expect(await queueIds()).toEqual([]);
  });

  it('"ok" with the appeal flag on a case without an appeal ruling is refused too', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: true })).toEqual({ ok: false, why: 'no_appeal' });
    expect(await queueIds()).toEqual([filed.caseId]);
  });

  it('a violation needs no appeal flag: any ruling the reviewer read is enough to take the case down', async () => {
    const t = paidMode(db);
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    expect(await db.store.reviewRuling(filed.caseId, { result: 'serious' })).toEqual({ ok: true });
    expect(await queueIds()).toEqual([]);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(410);
  });

  it('refuses a case that doesn’t exist or isn’t ruled yet, and stores nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect(await db.store.reviewRuling('nonexistentcase0', { result: 'ok', withAppeal: false })).toEqual({ ok: false, why: 'missing' });
    expect(await db.store.reviewRuling(filed.caseId, { result: 'ok', withAppeal: false })).toEqual({ ok: false, why: 'not_ruled' });
    expect(await db.store.reviewRuling(filed.caseId, { result: 'names_someone' })).toEqual({ ok: false, why: 'not_ruled' });
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
    expect(await db.sql('SELECT review FROM cases WHERE id = $1', [filed.caseId])).toEqual([{ review: null }]);
  });

  it('a ruling deleted before anyone reviewed it is "missed"; a reviewed one stays reviewed after it goes', async () => {
    const t = db.setup();
    const unreviewed = await t.ruledCase({ title: 'Never reviewed' });
    const reviewed = await t.ruledCase({ title: 'Reviewed' });
    await db.store.reviewRuling(reviewed.caseId, { result: 'ok', withAppeal: false });
    await t.deleteCase(unreviewed.caseId, unreviewed.plaintiffToken);
    t.advance(31 * DAY);
    await t.expire();
    expect(await safety()).toEqual({ rulings: 2, reviewed: 1, violations: 0, pending: 0, missed: 1 });
  });

  it('the queue honours --since, like the report', async () => {
    const t = db.setup();
    await t.ruledCase({ title: 'Deploy check' });
    t.advance(2 * DAY);
    const real = await t.ruledCase({ title: 'Real case' });
    expect(await queueIds({ since: '2026-11-03' })).toEqual([real.caseId]);
    expect(await queueIds({ since: '2026-11-04' })).toEqual([]);
  });
});

describe('what the safety review means for the decision', () => {
  const demandPasses = { cases: 30, gone: 30, answered: 15, jury2: 9, visitors: 40, clicked: 3, paid: 1 };

  it('a clean, complete review passes; a violation fails; waiting or missed rulings hold the decision', () => {
    const cases = [
      [{ rulings: 4, reviewed: 4, violations: 0, pending: 0, missed: 0 }, 'pass', 'continue'],
      [{ rulings: 4, reviewed: 4, violations: 1, pending: 0, missed: 0 }, 'fail', 'hold'],
      [{ rulings: 4, reviewed: 3, violations: 0, pending: 1, missed: 0 }, 'pending', 'hold'],
      [{ rulings: 4, reviewed: 3, violations: 0, pending: 0, missed: 1 }, 'incomplete', 'hold'],
      [{ rulings: 0, reviewed: 0, violations: 0, pending: 0, missed: 0 }, 'pass', 'continue'],
    ];
    for (const [review, safetyStatus, status] of cases) {
      const result = decide({ ...demandPasses, ...review });
      expect(result.safety.status, JSON.stringify(review)).toBe(safetyStatus);
      expect(result.status, JSON.stringify(review)).toBe(status);
    }
    expect(decide({ ...demandPasses, rulings: 4, reviewed: 3, violations: 0, pending: 1, missed: 0 }).reasons).toEqual([
      expect.stringMatching(/1 ruling waits for review/),
    ]);
    expect(decide({ ...demandPasses, rulings: 4, reviewed: 4, violations: 1, pending: 0, missed: 0 }).reasons).toEqual([
      expect.stringMatching(/1 ruling broke the safety bar/),
    ]);
    expect(decide({ ...demandPasses, rulings: 4, reviewed: 3, violations: 0, pending: 0, missed: 1 }).reasons).toEqual([
      expect.stringMatching(/1 ruling was deleted before anyone reviewed it/),
    ]);
  });

  it(`${REVIEW_SAMPLE} clean reviews complete the PRD's sample: rulings still waiting after that don't hold the decision`, () => {
    const result = decide({ ...demandPasses, rulings: 130, reviewed: 100, violations: 0, pending: 25, missed: 5 });
    expect(result.safety.status).toBe('pass');
    expect(result.status).toBe('continue');
    expect(decide({ ...demandPasses, rulings: 130, reviewed: 99, violations: 0, pending: 31, missed: 0 }).status).toBe('hold');
    // A violation found after the sample still counts.
    expect(decide({ ...demandPasses, rulings: 130, reviewed: 101, violations: 1, pending: 0, missed: 0 }).status).toBe('hold');
  });
});
