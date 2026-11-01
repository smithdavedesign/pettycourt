// M5 exit criteria 1–3: every PRD threshold applied to the recorded cases, no decision under 30 cases,
// and the roadmap's fold rule (plus REVIEW.md's kill criteria).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_CASES, REVIEW_SAMPLE, THRESHOLDS, decide, formatReport } from '../src/decide.js';
import { COHORT, fileCohort } from './cohort.js';
import { T0, testDatabase } from './helpers.js';
import { paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

/** Totals for `cases` cases that clear every bar, with a clean safety review; override what a test needs. */
function totals(overrides = {}) {
  const cases = overrides.cases ?? 30;
  return {
    cases,
    gone: cases,
    answered: Math.ceil(cases * 0.5),
    jury2: Math.ceil(cases * 0.3),
    visitors: cases * 2,
    clicked: Math.ceil(cases * 0.1),
    paid: Math.ceil(cases * 0.05),
    rulings: 10,
    reviewed: 10,
    violations: 0,
    pending: 0,
    missed: 0,
    ...overrides,
  };
}

const metric = (result, key) => result.metrics.find((m) => m.key === key);

describe('M5 exit criterion 1: every PRD threshold is applied to the recorded cases', () => {
  it('has one bar per PRD success metric, with the PRD’s numbers', () => {
    const bars = Object.fromEntries(THRESHOLDS.map((m) => [m.key, [m.percent, m.minCount ?? 0, m.onFail]]));
    expect(bars).toEqual({
      answered: [40, 0, 'fold'],
      jury2: [25, 0, 'fold'],
      visitors: [100, 0, 'watch'], // 1.0 new visitor per case = 100% of the case count
      clicked: [5, 0, 'watch'],
      paid: [2, 1, 'fold'],
    });
    expect(MIN_CASES).toBe(30);
    expect(REVIEW_SAMPLE).toBe(100);
  });

  it('30 cases driven through the API give the exact counts, rates and pass/fail of each metric', async () => {
    await db.sql('DELETE FROM cases');
    await db.sql('DELETE FROM case_outcomes');
    const t = paidMode(db);
    await fileCohort(t);

    const counted = await db.store.outcomeTotals();
    expect(counted).toEqual({
      cases: 30,
      gone: 0,
      answered: COHORT.answered,
      jury2: COHORT.jury2,
      visitors: COHORT.visitors,
      clicked: COHORT.clicked,
      paid: COHORT.paid,
      rulings: COHORT.rulings,
      reviewed: 0,
      violations: 0,
      pending: COHORT.rulings,
      missed: 0,
    });

    const result = decide(counted);
    expect(metric(result, 'answered')).toMatchObject({ count: 14, pass: true });
    expect(metric(result, 'answered').value).toBeCloseTo(14 / 30);
    expect(metric(result, 'jury2')).toMatchObject({ count: 9, pass: true });
    expect(metric(result, 'visitors')).toMatchObject({ count: 36, pass: true });
    expect(metric(result, 'visitors').value).toBeCloseTo(1.2);
    expect(metric(result, 'clicked')).toMatchObject({ count: 3, pass: true });
    expect(metric(result, 'paid')).toMatchObject({ count: 1, pass: true });
    expect(result.safety).toEqual({ status: 'pending', rulings: 5, reviewed: 0, violations: 0, pending: 5, missed: 0 });
    // Demand passes, but five rulings are unreviewed, so it can't say "continue" yet.
    expect(result.status).toBe('hold');
    expect(result.provisional).toBe(true);

    // The operator reviews the five rulings: the same cases now say "continue".
    for (const item of await db.store.reviewQueue()) {
      expect(await db.store.reviewRuling(item.id, { result: 'ok', withAppeal: item.appealRuling !== null })).toEqual({ ok: true });
    }
    const reviewed = decide(await db.store.outcomeTotals());
    expect(reviewed.safety).toMatchObject({ status: 'pass', reviewed: 5, pending: 0 });
    expect(reviewed.status).toBe('continue');

    const text = formatReport(reviewed, { at: T0 });
    for (const line of [
      /^pass {2}The defendant answered the summons\n {6}14 of 30 = 46\.7%, bar at least 40% \(fold if it fails\)$/m,
      /^pass {2}Cases with 2 or more jury votes\n {6}9 of 30 = 30\.0%, bar at least 25% \(fold if it fails\)$/m,
      /^pass {2}New visitors per case beyond the plaintiff\n {6}36 for 30 = 1\.20 per case, bar at least 1\.0 per case \(watch\)$/m,
      /^pass {2}Cases that clicked the \$3 unlock\n {6}3 of 30 = 10\.0%, bar at least 5% \(watch\)$/m,
      /^pass {2}Cases that paid \$3\n {6}1 of 30 = 3\.3%, bar at least 2% and 1 case \(fold if it fails\)$/m,
      /^pass {2}Safety review: 5 of 5 rulings reviewed, 0 violations$/m,
      /^Decision: CONTINUE \(provisional\)$/m,
      /^30 cases are still live/m,
    ]) {
      expect(text).toMatch(line);
    }
    // It fits an 80-column terminal.
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('a case refused at filing never counts: it was never stored', async () => {
    await db.sql('DELETE FROM cases');
    await db.sql('DELETE FROM case_outcomes');
    const t = db.setup();
    expect((await t.post('/cases', { charge: 'my boyfriend hits me', testimony: 'Please help.' })).status).toBe(422);
    await t.fileCase();
    expect((await db.store.outcomeTotals()).cases).toBe(1);
  });
});

describe('M5 exit criterion 2: no decision under 30 cases', () => {
  it('29 cases: keep collecting, one more to go, even when every bar is cleared', () => {
    const result = decide(totals({ cases: 29 }));
    expect(result.status).toBe('collecting');
    expect(result.needed).toBe(1);
    expect(result.provisional).toBe(false);
    expect(result.advice).toMatch(/Keep collecting: 29 of 30 cases \(1 more to go\)/);
    expect(formatReport(result, { at: T0 })).toMatch(/Decision: KEEP COLLECTING/);
  });

  it('29 cases that would fail still make no decision', () => {
    expect(decide(totals({ cases: 29, answered: 0, paid: 0 })).status).toBe('collecting');
  });

  it('0 cases: no division by zero, every rate is empty and nothing passes', () => {
    const result = decide(totals({ cases: 0, gone: 0, answered: 0, jury2: 0, visitors: 0, clicked: 0, paid: 0, rulings: 0, reviewed: 0 }));
    expect(result.status).toBe('collecting');
    expect(result.needed).toBe(30);
    for (const m of result.metrics) expect(m, m.key).toMatchObject({ value: null, pass: false });
    const text = formatReport(result, { at: T0 });
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(text).toMatch(/Keep collecting: 0 of 30 cases \(30 more to go\)/);
  });

  it('exactly 30 cases is enough to decide', () => {
    expect(decide(totals({ cases: 30 })).status).toBe('continue');
  });
});

describe('M5 exit criterion 3: the fold rule', () => {
  it('defendant response: 12 of 30 (exactly 40%) passes, 11 of 30 folds', () => {
    expect(metric(decide(totals({ answered: 12 })), 'answered').pass).toBe(true);
    expect(decide(totals({ answered: 12 })).status).toBe('continue');
    const folded = decide(totals({ answered: 11 }));
    expect(folded.status).toBe('fold');
    expect(folded.reasons).toEqual([expect.stringMatching(/The defendant answered the summons: 11 of 30, 36\.7% \(bar: at least 40%\)/)]);
    expect(folded.advice).toMatch(/fold the flow into tiebreak as a mode and stop/i);
  });

  it('paid conversion: no paying case folds; 1 of 30 (3.3%) passes; at 51 cases one payer is under 2% and folds', () => {
    expect(decide(totals({ paid: 0 })).status).toBe('fold');
    expect(decide(totals({ paid: 0 })).reasons[0]).toMatch(/Cases that paid \$3: 0 of 30/);
    expect(decide(totals({ paid: 1 })).status).toBe('continue');
    expect(decide(totals({ cases: 51, paid: 1 })).status).toBe('fold');
    expect(decide(totals({ cases: 51, paid: 2 })).status).toBe('continue');
    // 2% of 50 is exactly one case: the bar is inclusive.
    expect(decide(totals({ cases: 50, paid: 1 })).status).toBe('continue');
  });

  it('jury turnout (REVIEW.md kill criterion): 8 of 30 (26.7%) passes, 7 of 30 (23.3%) folds', () => {
    expect(decide(totals({ jury2: 8 })).status).toBe('continue');
    expect(decide(totals({ jury2: 7 })).status).toBe('fold');
  });

  it('several failures are all listed', () => {
    const result = decide(totals({ answered: 3, jury2: 1, paid: 0 }));
    expect(result.status).toBe('fold');
    expect(result.reasons).toHaveLength(3);
  });

  it('visitors and unlock clicks are watched, not fatal: they give warnings under "continue"', () => {
    const result = decide(totals({ visitors: 29, clicked: 1 }));
    expect(result.status).toBe('continue');
    expect(result.warnings).toEqual([
      expect.stringMatching(/New visitors per case beyond the plaintiff: 29 for 30, 0\.97 per case \(bar: at least 1\.0 per case\)/),
      expect.stringMatching(/Cases that clicked the \$3 unlock: 1 of 30, 3\.3% \(bar: at least 5%\)/),
    ]);
    expect(metric(decide(totals({ visitors: 30 })), 'visitors').pass).toBe(true);
  });

  it('a fold stands whatever the safety review says; a passing demand needs a clean review to continue', () => {
    expect(decide(totals({ answered: 0, violations: 1 })).status).toBe('fold');
    expect(decide(totals({ violations: 1 })).status).toBe('hold');
    expect(decide(totals({ reviewed: 8, pending: 2 })).status).toBe('hold');
    expect(decide(totals({ reviewed: 8, missed: 2 })).status).toBe('hold');
    expect(decide(totals({ rulings: 0, reviewed: 0 })).status).toBe('continue');
  });

  it('the report says fold in words, with the reasons', () => {
    const text = formatReport(decide(totals({ answered: 11, paid: 0, gone: 30 })), { at: T0, since: '2026-11-05' });
    expect(text).toMatch(/cases filed since 2026-11-05/);
    expect(text).toMatch(/^Decision: FOLD$/m);
    expect(text).toMatch(/fold the flow into tiebreak as a mode and stop/i);
    expect(text).toMatch(/^FAIL {2}The defendant answered the summons\n {6}11 of 30 = 36\.7%/m);
    expect(text).toMatch(/^FAIL {2}Cases that paid \$3\n {6}0 of 30 = 0\.0%/m);
    expect(text).not.toMatch(/provisional/);
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('the report marks the safety review as waiting, failed or with a gap', () => {
    const report = (review) => formatReport(decide(totals(review)), { at: T0 });
    expect(report({ reviewed: 8, pending: 2 })).toMatch(/^WAIT {2}Safety review: 8 of 10 rulings reviewed, 0 violations\n {6}2 waiting/m);
    expect(report({ violations: 1 })).toMatch(/^FAIL {2}Safety review: 10 of 10 rulings reviewed, 1 violation$/m);
    expect(report({ reviewed: 9, missed: 1 })).toMatch(/^GAP {3}Safety review: 9 of 10 rulings reviewed, 0 violations\n {6}0 waiting, 1 deleted before review/m);
    expect(report({ reviewed: 8, pending: 2 })).toMatch(/^Decision: HOLD$/m);
  });

  it('is provisional while cases are still live, final once they have all gone', () => {
    expect(decide(totals({ gone: 25 }))).toMatchObject({ live: 5, provisional: true });
    expect(decide(totals({ gone: 30 }))).toMatchObject({ live: 0, provisional: false });
    expect(formatReport(decide(totals({ gone: 25 })), { at: T0 })).toMatch(/5 cases are still live/);
  });
});
