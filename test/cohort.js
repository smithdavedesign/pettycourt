// M5: a sample cohort driven through the real API (filing, summons, jury, visits, the unlock, a Stripe
// test payment and rulings), with outcomes chosen so every PRD metric has a known count.
import { expect } from 'vitest';
import { newDevice } from './helpers.js';

/** What `fileCohort` produces: 30 cases, and how many of them reached each outcome. */
export const COHORT = {
  cases: 30,
  answered: 14, // 46.7%: over the 40% bar
  jury2: 9, // 30%: over 25%
  visitors: 36, // 1.2 per case: over 1.0
  clicked: 3, // 10%: over 5% (two fake-door clicks and the paid checkout)
  paid: 1, // 3.3%: over 2%, and at least one case
  rulings: 5,
};

/** One visit, the way the client script reports it. */
export async function visit(t, caseId) {
  const res = await t.post('/visits', { caseId });
  expect(res.status, `visit ${caseId}`).toBe(204);
}

/**
 * File the cohort through `t`, a `paidMode(db)` app (it needs the fake Stripe for the paying case).
 * @returns {Promise<Array<{ caseId: string, summonsToken: string, juryToken: string, plaintiffToken: string }>>}
 *   the 30 filings, oldest first; index 0 is the paid case, 0–13 answered, 0–4 ruled.
 */
export async function fileCohort(t) {
  const paid = await t.paidCase({ title: 'Cohort case 1: the paid appeal' });
  const filed = [paid];
  for (let i = 2; i <= COHORT.cases; i += 1) filed.push(await t.fileCase({ title: `Cohort case ${i}` }));

  // The paid case was answered and ruled by paidCase(); 13 more defendants answer, 4 of those are ruled.
  for (const f of filed.slice(1, COHORT.answered)) expect((await t.answer(f.summonsToken)).status).toBe(201);
  for (const f of filed.slice(1, COHORT.rulings)) expect((await t.post(`/cases/${f.caseId}/rule`)).status).toBe(200);

  // Nine juries with two votes each, three with a single vote (which doesn't reach the bar).
  for (const f of filed.slice(0, COHORT.jury2)) {
    for (const vote of ['guilty', 'not_guilty']) expect((await t.vote(f.juryToken, { vote }, newDevice())).status).toBe(201);
  }
  for (const f of filed.slice(COHORT.jury2, COHORT.jury2 + 3)) {
    expect((await t.vote(f.juryToken, { vote: 'guilty' }, newDevice())).status).toBe(201);
  }

  // Twelve cases with three visitors each.
  for (const f of filed.slice(0, 12)) for (let v = 0; v < 3; v += 1) await visit(t, f.caseId);

  // Two fake-door clicks on unpaid cases (the paid case's checkout is the third click).
  for (const f of filed.slice(20, 22)) expect((await t.unlock(f.caseId)).status).toBe(200);
  return filed;
}
