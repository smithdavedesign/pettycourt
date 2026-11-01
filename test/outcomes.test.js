// M5 exit criterion 4: the numbers outlive the cases. Deleting a case (either party) or the 30-day expiry
// keeps one anonymous outcome row, written by the same statement, so the report doesn't change, while
// M3's promise holds: nothing left in any case table, and nothing kept that leads back to the case.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decide } from '../src/decide.js';
import { COHORT, fileCohort, visit } from './cohort.js';
import { DAY, judgeReply, newDevice, testDatabase } from './helpers.js';
import { paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
beforeEach(async () => {
  await db.sql('DELETE FROM cases');
  await db.sql('DELETE FROM case_outcomes');
});

// Constant column names, so the test query below interpolates nothing from input.
const OUTCOME_COLUMNS = [
  'id',
  'filed_on',
  'gone_by',
  'answered',
  'ruled',
  'taken_down',
  'clicked',
  'paid',
  'votes',
  'visitors',
  'review',
  'review_pending',
];

/** The rows kept for gone cases, oldest first, without their identity column (the day as text). */
async function kept() {
  const columns = OUTCOME_COLUMNS.filter((c) => c !== 'id').map((c) => (c === 'filed_on' ? 'filed_on::text AS filed_on' : c));
  return db.sql(`SELECT ${columns.join(', ')} FROM case_outcomes ORDER BY id`);
}

describe('M5 exit criterion 4: the report survives deletion and the 30-day expiry', () => {
  it('a plaintiff delete, a defendant delete and the day-31 expiry leave every number unchanged', async () => {
    const t = paidMode(db);
    const filed = await fileCohort(t);
    // Review the rulings first, so the safety numbers are complete before anything goes.
    for (const item of await db.store.reviewQueue()) {
      await db.store.reviewRuling(item.id, { result: 'ok', withAppeal: item.appealRuling !== null });
    }
    const before = await db.store.outcomeTotals();
    expect(before).toMatchObject({ cases: 30, gone: 0, answered: COHORT.answered, paid: 1, reviewed: 5 });

    // The paid, answered, ruled, voted, visited case is deleted by its plaintiff; an answered case by its defendant.
    expect((await t.deleteCase(filed[0].caseId, filed[0].plaintiffToken)).status).toBe(200);
    expect((await t.deleteCase(filed[5].caseId, filed[5].summonsToken)).status).toBe(200);
    const afterDeletes = await db.store.outcomeTotals();
    expect(afterDeletes).toEqual({ ...before, gone: 2 });

    t.advance(31 * DAY);
    expect((await (await t.expire()).json()).deleted).toBe(28);
    const afterExpiry = await db.store.outcomeTotals();
    expect(afterExpiry).toEqual({ ...before, gone: 30 });

    // Same decision, and now final: nothing is still live.
    const [was, now] = [decide(before), decide(afterExpiry)];
    expect(now.metrics).toEqual(was.metrics);
    expect(now.status).toBe('continue');
    expect(now.provisional).toBe(false);

    // M3's promise: no row about any case is left in a case table, and every link is a 404.
    for (const f of filed) {
      expect(await db.rowsFor(f.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    }
    expect((await t.get(`/cases/${filed[0].caseId}`)).status).toBe(404);
    expect((await db.sql('SELECT gone_by, count(*)::int AS n FROM case_outcomes GROUP BY 1 ORDER BY 1'))).toEqual([
      { gone_by: 'deleted', n: 2 },
      { gone_by: 'expired', n: 28 },
    ]);
  });

  it('keeps no id, token, link, text or exact time: nothing leads back to the case', async () => {
    const t = paidMode(db);
    const filed = await t.paidCase({ title: 'The Great Shower Affair', charge: 'Said five minutes away from the shower' });
    await t.vote(filed.juryToken, { vote: 'guilty', comment: 'Showers are not transport.' }, newDevice());
    await t.unlockEmail(filed.caseId, { clickId: filed.clickId, email: 'juror@example.com' });
    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(201);
    const secrets = [
      filed.caseId,
      filed.summonsToken,
      filed.juryToken,
      filed.plaintiffToken,
      filed.clickId,
      filed.session.id,
      'Shower',
      'shower',
      'five minutes',
      'cinema',
      'transport',
      'juror@example.com',
      'taxi',
      'Order in the group chat',
    ];
    expect((await t.deleteCase(filed.caseId, filed.plaintiffToken)).status).toBe(200);

    const columns = (
      await db.sql(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'case_outcomes' ORDER BY ordinal_position`)
    ).map((c) => [c.column_name, c.data_type]);
    expect(columns.map(([name]) => name)).toEqual(OUTCOME_COLUMNS);
    // Only days, never times; the only text columns are short enums.
    expect(columns.filter(([, type]) => type.startsWith('timestamp'))).toEqual([]);
    expect(columns.filter(([, type]) => type === 'text').map(([name]) => name)).toEqual(['gone_by', 'review']);
    const foreignKeys = await db.sql(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'case_outcomes'::regclass AND contype = 'f'`,
    );
    expect(foreignKeys).toEqual([]);

    const rows = await db.sql('SELECT * FROM case_outcomes');
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    for (const secret of secrets) expect(dump, secret).not.toContain(secret);
    expect(await kept()).toEqual([
      {
        filed_on: '2026-11-01',
        gone_by: 'deleted',
        answered: true,
        ruled: true,
        taken_down: false,
        clicked: true,
        paid: true,
        votes: 1,
        visitors: 0,
        review: null,
        review_pending: true,
      },
    ]);
  });

  it('keeps the right outcome for a case in every state', async () => {
    const t = paidMode(db, {
      // The judge declines the case whose charge carries a marker; everything else gets the usual ruling.
      judge: async (file) => (file.charge.includes('[decline me]') ? judgeReply('declined', '') : judgeReply('guilty')),
    });
    const fresh = await t.fileCase({ title: 'Fresh' });
    const answered = await t.fileCase({ title: 'Answered' });
    await t.answer(answered.summonsToken);
    await visit(t, answered.caseId);
    await visit(t, answered.caseId);
    const declined = await t.fileCase({ title: 'Declined', charge: 'Left the lid off the jam [decline me]' });
    await t.answer(declined.summonsToken);
    expect((await t.post(`/cases/${declined.caseId}/rule`)).status).toBe(422);
    const down = await t.ruledCase({ title: 'Taken down' });
    expect((await t.report(down.caseId)).status).toBe(201);
    const reviewed = await t.ruledCase({ title: 'Reviewed and fine' });
    await db.store.reviewRuling(reviewed.caseId, { result: 'ok', withAppeal: false });
    const noShow = await t.fileCase({ title: 'No-show' });
    t.advance(DAY + 1);
    expect((await t.post(`/cases/${noShow.caseId}/rule`)).status).toBe(200);

    for (const f of [fresh, answered, declined, down, reviewed, noShow]) {
      expect((await t.deleteCase(f.caseId, f.plaintiffToken)).status).toBe(200);
    }
    const base = { filed_on: '2026-11-01', gone_by: 'deleted', clicked: false, paid: false, votes: 0, visitors: 0, taken_down: false, review: null };
    expect(await kept()).toEqual([
      { ...base, answered: false, ruled: false, review_pending: false },
      { ...base, answered: true, ruled: false, visitors: 2, review_pending: false },
      { ...base, answered: true, ruled: false, review_pending: false },
      { ...base, answered: true, ruled: true, taken_down: true, review_pending: true },
      { ...base, answered: true, ruled: true, review: 'ok', review_pending: false },
      { ...base, answered: false, ruled: true, review_pending: true },
    ]);
  });

  it('a delete racing the expiry on the same case keeps exactly one outcome', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(31 * DAY);
    const [deleted, expired] = await Promise.all([t.deleteCase(filed.caseId, filed.plaintiffToken), t.expire()]);
    const removed = [deleted.status === 200 ? 1 : 0, (await expired.json()).deleted].reduce((a, b) => a + b);
    expect(removed).toBe(1);
    expect(await db.sql('SELECT gone_by FROM case_outcomes')).toHaveLength(1);
  });

  it('the expiry keeps one outcome per case across batches', async () => {
    const t = db.setup();
    for (let i = 0; i < 7; i += 1) await t.fileCase({ title: `Batch ${i}` });
    t.advance(31 * DAY);
    const cutoff = new Date(t.clock.now.getTime() - 30 * DAY);
    expect(await db.store.deleteFiledBefore(cutoff, { batchSize: 3 })).toHaveLength(7);
    expect((await db.sql(`SELECT count(*)::int AS n FROM case_outcomes WHERE gone_by = 'expired'`))[0].n).toBe(7);
  });

  it('a wrong token deletes nothing and keeps nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.deleteCase(filed.caseId, filed.juryToken)).status).toBe(404);
    expect(await kept()).toEqual([]);
    expect((await db.store.outcomeTotals()).cases).toBe(1);
  });

  it('--since counts only cases filed on or after that day, live and gone alike', async () => {
    const t = db.setup();
    const early = await t.fileCase({ title: 'Deploy check' });
    await t.fileCase({ title: 'Also a deploy check' });
    t.advance(3 * DAY);
    const real = await t.fileCase({ title: 'First real case' });
    await t.answer(real.summonsToken);
    await t.fileCase({ title: 'Second real case' });
    expect((await t.deleteCase(early.caseId, early.plaintiffToken)).status).toBe(200);
    expect((await t.deleteCase(real.caseId, real.plaintiffToken)).status).toBe(200);

    expect(await db.store.outcomeTotals()).toMatchObject({ cases: 4, gone: 2, answered: 1 });
    expect(await db.store.outcomeTotals({ since: '2026-11-04' })).toMatchObject({ cases: 2, gone: 1, answered: 1 });
    expect(await db.store.outcomeTotals({ since: '2026-11-05' })).toMatchObject({ cases: 0, gone: 0 });
  });
});
