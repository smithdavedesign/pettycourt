// `npm run decide`: the M5 decision, for the operator. It reads the same database as the app (DATABASE_URL,
// from the keychain; without it, the local PGlite data of `npm run dev`) and never prints the URL.
//
//   npm run decide [-- --since YYYY-MM-DD] [--json]     the PRD thresholds, the decision and why
//   npm run decide -- review [--since YYYY-MM-DD]        rulings waiting for the safety review
//   npm run decide -- ok <caseId> [--with-appeal]        the ruling (and the appeal ruling) is fine
//   npm run decide -- violation <caseId> names_someone|serious   it isn't: take the case down
//
// Exit codes: 0 done, 1 the command failed (no such case, a stale review), 2 usage error.
// There's no web page for this on purpose: it would need a login on a public app, and the operator already
// holds DATABASE_URL.

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDeps } from '../src/config.js';
import { cleanText, decide, formatQueue, formatReport } from '../src/decide.js';
import { REVIEW_RESULTS } from '../src/store.js';

export const USAGE = `Usage:
  npm run decide [-- --since YYYY-MM-DD] [--json]     the PRD thresholds and the decision
  npm run decide -- review [--since YYYY-MM-DD]        rulings waiting for the safety review
  npm run decide -- ok <caseId> [--with-appeal]        the ruling (and appeal ruling) is fine
  npm run decide -- violation <caseId> names_someone|serious
                                                       it isn't: record it, take the case down
  npm run decide -- help
--since counts cases filed on or after that day (UTC).`;

const VIOLATIONS = REVIEW_RESULTS.filter((result) => result !== 'ok');

/** A real calendar day written YYYY-MM-DD. */
function isDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const WHY = {
  missing: (id) => `No case ${id}. It may have been deleted or expired.`,
  not_ruled: (id) => `Case ${id} hasn't been ruled yet, so there's no ruling to review.`,
  has_appeal: (id) =>
    `Case ${id} now has an appeal ruling as well, which "ok" without --with-appeal doesn't cover. ` +
    'Run review again to read it, then answer with --with-appeal.',
  no_appeal: (id) => `Case ${id} has no appeal ruling, so --with-appeal doesn't apply. Run review again.`,
};

/**
 * The command line without the process around it.
 * @param {string[]} argv  the arguments after the script name
 * @param {{ store: ReturnType<typeof import('../src/store.js').createStore>, now?: () => Date,
 *   out?: (line: string) => void, err?: (line: string) => void }} io
 * @returns {Promise<0 | 1 | 2>} the exit code
 */
export async function run(argv, { store, now = () => new Date(), out = console.log, err = console.error }) {
  const usage = (message) => {
    if (message) err(message);
    err(USAGE);
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { since: { type: 'string' }, json: { type: 'boolean' }, 'with-appeal': { type: 'boolean' } },
    });
  } catch (error) {
    return usage(error.message);
  }
  const { values, positionals } = parsed;
  const [command = 'report', ...rest] = positionals;
  const since = values.since ?? null;
  if (since !== null && !isDay(since)) return usage('--since takes a day written YYYY-MM-DD.');
  /** Only these options may come with this command. */
  const only = (...allowed) => Object.keys(values).every((name) => allowed.includes(name));

  if (command === 'help') {
    out(USAGE);
    return 0;
  }

  if (command === 'report') {
    if (!only('since', 'json')) return usage();
    const result = decide(await store.outcomeTotals({ since }));
    out(values.json ? JSON.stringify({ ...result, since }, null, 2) : formatReport(result, { at: now(), since }));
    return 0;
  }

  if (command === 'review') {
    if (rest.length || !only('since')) return usage();
    const [items, totals] = await Promise.all([store.reviewQueue({ since }), store.outcomeTotals({ since })]);
    out(formatQueue(items, { total: totals.pending, reviewed: totals.reviewed }));
    return 0;
  }

  if (command === 'ok' || command === 'violation') {
    const [id, reason, ...extra] = rest;
    if (!id || extra.length) return usage();
    let review;
    if (command === 'ok') {
      if (reason !== undefined || !only('with-appeal')) return usage();
      review = { result: 'ok', withAppeal: Boolean(values['with-appeal']) };
    } else {
      if (!VIOLATIONS.includes(reason) || !only()) return usage(`A violation is one of: ${VIOLATIONS.join(', ')}.`);
      review = { result: reason };
    }
    const shown = cleanText(id);
    const done = await store.reviewRuling(id, { ...review, at: now() });
    if (!done.ok) {
      err(WHY[done.why](shown));
      return 1;
    }
    out(
      review.result === 'ok'
        ? `Reviewed ${shown}: ok.`
        : `Reviewed ${shown}: ${review.result}. The case is taken down for everyone, with a report that says why.`,
    );
    return 0;
  }

  return usage(`Unknown command: ${cleanText(command)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = createDeps(process.env, { local: true });
  console.error(
    deps.dbKind === 'postgres'
      ? 'Reading the database from DATABASE_URL.'
      : 'No DATABASE_URL: reading local PGlite data (PGLITE_DIR, or .data/pglite). Stop `npm run dev` first if it uses the same folder.',
  );
  try {
    process.exitCode = await run(process.argv.slice(2), { store: deps.store });
  } catch (error) {
    console.error(`decide failed: ${error?.message}`);
    process.exitCode = 1;
  } finally {
    await deps.close();
  }
}
