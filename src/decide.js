// M5, "Decide" (ROADMAP.md): the PRD's success thresholds applied to every case filed, live or gone, and
// the roadmap's rule on top of them: "If defendant response is under 40% or paid conversion is under 2%,
// fold the flow into tiebreak as a mode and stop." REVIEW.md's kill criteria add "under 25% of cases with
// 2+ jury votes" and "fewer than 1 in 30 cases paying". Pure functions over store.outcomeTotals(); the
// operator runs them through `npm run decide` (scripts/decide.js).

import { VERDICT_LABELS } from './judge.js';
import { RETENTION_MS } from './store.js';

/** The PRD's bars are judged on 30 or more cases ("Of 30 cases filed…"). */
export const MIN_CASES = 30;
/** The PRD checks "every ruling in the first 100": once 100 rulings are reviewed, the sample is complete. */
export const REVIEW_SAMPLE = 100;

/**
 * The PRD's success metrics, each a count of cases compared with the number of cases filed.
 * percent: the bar as a share of the cases (for visitors, 100 means one new visitor per case on average).
 * minCount: an absolute floor as well ("fewer than 1 of 30 cases pays").
 * onFail: 'fold' for a kill criterion (ROADMAP M5 and REVIEW.md), 'watch' for the other PRD metrics.
 * @type {Array<{ key: string, label: string, percent: number, minCount?: number, perCase?: boolean, onFail: 'fold' | 'watch' }>}
 */
export const THRESHOLDS = [
  { key: 'answered', label: 'The defendant answered the summons', percent: 40, onFail: 'fold' },
  { key: 'jury2', label: 'Cases with 2 or more jury votes', percent: 25, onFail: 'fold' },
  { key: 'visitors', label: 'New visitors per case beyond the plaintiff', percent: 100, perCase: true, onFail: 'watch' },
  { key: 'clicked', label: 'Cases that clicked the $3 unlock', percent: 5, onFail: 'watch' },
  { key: 'paid', label: 'Cases that paid $3', percent: 2, minCount: 1, onFail: 'fold' },
];

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Strips what a terminal could interpret from user or model text before it's printed: control and format
 * characters (escape sequences, C1 controls such as CSI, bidi overrides) go, and whitespace runs, line
 * breaks included, become one space.
 */
export function cleanText(text) {
  return String(text)
    .replace(/[\s\u0085]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** "14 of 30" (visitors: "36 for 30"). */
const share = (m, cases) => `${m.count} ${m.perCase ? 'for' : 'of'} ${cases}`;
/** "46.7%" or "1.20 per case"; a dash without cases. */
const rate = (m) => {
  if (m.value === null) return '–';
  return m.perCase ? `${m.value.toFixed(2)} per case` : `${(m.value * 100).toFixed(1)}%`;
};
/** "at least 40%", "at least 2% and 1 case", "at least 1.0 per case". */
const bar = (m) => {
  if (m.perCase) return `at least ${(m.percent / 100).toFixed(1)} per case`;
  return `at least ${m.percent}%${m.minCount ? ` and ${m.minCount} ${plural(m.minCount, 'case', 'cases')}` : ''}`;
};
const reasonFor = (m, cases) => `${m.label}: ${share(m, cases)}, ${rate(m)} (bar: ${bar(m)})`;

/**
 * Where the PRD's safety bar stands: zero published rulings that name someone outside the argument or fall
 * into the excluded topics, "checked by sampling every ruling in the first 100".
 */
function safetyOf({ rulings, reviewed, violations, pending, missed }) {
  let status;
  if (violations > 0) status = 'fail';
  else if (reviewed >= REVIEW_SAMPLE || (pending === 0 && missed === 0)) status = 'pass';
  else if (pending > 0) status = 'pending';
  else status = 'incomplete';
  return { status, rulings, reviewed, violations, pending, missed };
}

function safetyReasons(safety) {
  if (safety.status === 'pass') return [];
  const { violations, pending, missed } = safety;
  return [
    violations > 0 &&
      `${violations} ${plural(violations, 'ruling', 'rulings')} broke the safety bar (named someone outside the argument, or an excluded topic)`,
    pending > 0 && `${pending} ${plural(pending, 'ruling waits', 'rulings wait')} for review`,
    missed > 0 && `${missed} ${plural(missed, 'ruling was', 'rulings were')} deleted before anyone reviewed ${plural(missed, 'it', 'them')}`,
  ].filter(Boolean);
}

/**
 * Applies the thresholds and the roadmap's rule to the totals.
 * @param {{ cases: number, gone: number, answered: number, jury2: number, visitors: number, clicked: number,
 *   paid: number, rulings: number, reviewed: number, violations: number, pending: number, missed: number }} totals
 * @returns {{ status: 'collecting' | 'fold' | 'hold' | 'continue', provisional: boolean, cases: number,
 *   live: number, gone: number, needed: number, metrics: Array<object>, safety: ReturnType<typeof safetyOf>,
 *   reasons: string[], warnings: string[], advice: string }}
 *   collecting: under 30 cases. fold: a kill criterion failed. hold: demand passes but the safety review
 *   isn't clean (a violation, rulings waiting, or rulings deleted unreviewed). continue: everything passes;
 *   failing watch metrics are warnings. provisional: some counted cases are still live, so their answers,
 *   votes, clicks and payments can still come in.
 */
export function decide(totals) {
  const { cases, gone } = totals;
  const metrics = THRESHOLDS.map((m) => {
    const count = totals[m.key];
    // Integer comparison, so a bar hit exactly (12 of 30 is 40%) passes without floating-point doubt.
    const pass = cases > 0 && count * 100 >= m.percent * cases && count >= (m.minCount ?? 0);
    return { ...m, count, value: cases > 0 ? count / cases : null, pass };
  });
  const safety = safetyOf(totals);
  const failing = metrics.filter((m) => !m.pass);
  const folds = failing.filter((m) => m.onFail === 'fold').map((m) => reasonFor(m, cases));
  const warnings = failing.filter((m) => m.onFail === 'watch').map((m) => reasonFor(m, cases));
  const needed = Math.max(0, MIN_CASES - cases);
  const live = cases - gone;

  let status;
  let reasons = [];
  let advice;
  if (needed > 0) {
    status = 'collecting';
    advice = `Keep collecting: ${cases} of ${MIN_CASES} cases (${needed} more to go). The PRD's bars are judged on ${MIN_CASES} or more.`;
  } else if (folds.length) {
    status = 'fold';
    reasons = folds;
    advice = `Fold the flow into tiebreak as a mode and stop (ROADMAP M5): ${folds.join('; ')}.`;
  } else if (safety.status !== 'pass') {
    status = 'hold';
    reasons = safetyReasons(safety);
    advice =
      `Hold: demand clears the kill criteria, but the safety review isn't clean: ${reasons.join('; ')}. ` +
      'Review the rulings (npm run decide -- review), and fix whatever let a bad one through before growing it.';
  } else {
    status = 'continue';
    advice =
      "Continue: defendant response, jury turnout and payment all clear the PRD's bars, and the safety review is clean." +
      (warnings.length ? ` Below target, to watch: ${warnings.join('; ')}.` : '');
  }
  return { status, provisional: status !== 'collecting' && live > 0, cases, live, gone, needed, metrics, safety, reasons, warnings, advice };
}

const STATUS_WORDS = { collecting: 'KEEP COLLECTING', fold: 'FOLD', hold: 'HOLD', continue: 'CONTINUE' };
const SAFETY_WORDS = { pass: 'pass', fail: 'FAIL', pending: 'WAIT', incomplete: 'GAP' };
/** Terminal output fits in 80 columns. */
const WIDTH = 78;

/** Word-wraps `text` to WIDTH columns, keeping its leading spaces; continuation lines start with `indent`. */
function wrap(text, indent = '') {
  const lead = /^ */.exec(text)[0];
  const [first, ...words] = text.slice(lead.length).split(' ');
  const lines = [];
  let line = lead + first;
  for (const word of words) {
    if (line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = indent + word;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

/**
 * The report `npm run decide` prints: each PRD metric on two lines (pass or FAIL and its name, then the
 * numbers against the bar), the safety review, then the decision and why.
 * @param {ReturnType<typeof decide>} result
 * @param {{ at: Date, since?: string | null }} context
 */
export function formatReport(result, { at, since = null }) {
  const { cases, live, gone, safety } = result;
  const indent = '      ';
  const lines = [
    `Group Chat Court: the M5 decision, ${at.toISOString().slice(0, 10)} (${since ? `cases filed since ${since}` : 'all cases filed'})`,
    `Cases: ${cases} (${live} live, ${gone} deleted or expired)`,
    '',
  ];
  for (const m of result.metrics) {
    const word = m.value === null ? '–' : m.pass ? 'pass' : 'FAIL';
    lines.push(
      `${word.padEnd(6)}${m.label}`,
      wrap(`${indent}${share(m, cases)} = ${rate(m)}, bar ${bar(m)} (${m.onFail === 'fold' ? 'fold if it fails' : 'watch'})`, indent),
    );
  }
  lines.push(
    `${SAFETY_WORDS[safety.status].padEnd(6)}Safety review: ${safety.reviewed} of ${safety.rulings} rulings reviewed, ` +
      `${safety.violations} ${plural(safety.violations, 'violation', 'violations')}`,
    wrap(
      `${indent}${safety.pending} waiting, ${safety.missed} deleted before review; bar: no violations, ` +
        `and every ruling reviewed until ${REVIEW_SAMPLE} are`,
      indent,
    ),
    '',
    `Decision: ${STATUS_WORDS[result.status]}${result.provisional ? ' (provisional)' : ''}`,
    wrap(result.advice),
  );
  if (result.provisional) {
    lines.push(
      wrap(
        `${live} ${plural(live, 'case is', 'cases are')} still live (under 30 days old and not deleted), so answers, ` +
          'votes, clicks and payments can still come in. Run this again once they have closed.',
      ),
    );
  }
  return lines.join('\n');
}

/** "deleted on 2026-12-01 or the day after", as the case pages say it. */
const deletionDay = (createdAt) => new Date(createdAt.getTime() + RETENTION_MS).toISOString().slice(0, 10);

/**
 * The review queue `npm run decide -- review` prints: every ruling with what the reviewer must read, and
 * the exact commands to answer it. User and model text goes through cleanText.
 * @param {Awaited<ReturnType<ReturnType<typeof import('./store.js').createStore>['reviewQueue']>>} items
 * @param {{ total: number, reviewed: number }} counts  total: every ruling waiting (items may be fewer)
 */
export function formatQueue(items, { total, reviewed }) {
  const progress =
    reviewed >= REVIEW_SAMPLE
      ? `the PRD's sample of ${REVIEW_SAMPLE} is complete, so reviewing more is optional`
      : `${reviewed} of ${REVIEW_SAMPLE} reviewed so far`;
  if (!items.length) return `No rulings wait for review (${progress}).`;
  const lines = [
    wrap(
      `${total} ${plural(total, 'ruling waits', 'rulings wait')} for review (${progress}).` +
        (items.length < total ? ` These are the oldest ${items.length}.` : ''),
    ),
    wrap(
      'Read each one. Answer "ok" if it is fine, or "violation" if it names someone outside the argument ' +
        '(names_someone) or is about abuse, health, money or minors (serious). A violation takes the case down for everyone.',
    ),
  ];
  const field = (label, text) => wrap(`  ${label}: ${cleanText(text)}`, '    ');
  for (const item of items) {
    const id = cleanText(item.id);
    const appeal = item.appealRuling !== null;
    lines.push(
      '',
      `/cases/${id} (filed ${item.createdAt.toISOString().slice(0, 10)})`,
      `  It's deleted on ${deletionDay(item.createdAt)} or the day after: review it before then.`,
    );
    if (item.takenDown) lines.push('  Already taken down after a report.');
    lines.push(
      field('Title', item.title),
      field('Charge', item.charge),
      field(`Ruling (${VERDICT_LABELS[item.verdict]})`, item.ruling),
    );
    if (appeal) lines.push(field(`Appeal ruling (${VERDICT_LABELS[item.appealVerdict]})`, item.appealRuling));
    lines.push(`  npm run decide -- ok ${id}${appeal ? ' --with-appeal' : ''}`, `  npm run decide -- violation ${id} names_someone|serious`);
  }
  return lines.join('\n');
}
