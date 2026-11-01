// M5 exit criterion 7: the operator can run it. `npm run decide` prints the report and the decision, and
// `review`, `ok` and `violation` work from the command line. `run()` is the command line without the
// process around it; the last tests start the real script against an in-memory PGlite.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanText } from '../src/decide.js';
import { run } from '../scripts/decide.js';
import { T0, testDatabase } from './helpers.js';
import { paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
beforeEach(async () => {
  await db.sql('DELETE FROM cases');
  await db.sql('DELETE FROM case_outcomes');
});

/** Run the command line with `argv`; returns the exit code and what it printed. */
async function decide(argv) {
  const stdout = [];
  const stderr = [];
  const code = await run(argv, {
    store: db.store,
    now: () => T0,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('npm run decide: the report', () => {
  it('on an empty database: keep collecting, exit 0', async () => {
    const { code, stdout } = await decide([]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Group Chat Court: the M5 decision, 2026-11-01/);
    expect(stdout).toMatch(/Decision: KEEP COLLECTING/);
    expect(stdout).toMatch(/Keep collecting: 0 of 30 cases \(30 more to go\)/);
  });

  it('--json prints the whole result as JSON', async () => {
    const t = db.setup();
    await t.fileCase();
    const { code, stdout } = await decide(['--json']);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ status: 'collecting', cases: 1, live: 1, needed: 29 });
    expect(result.metrics.map((m) => m.key)).toEqual(['answered', 'jury2', 'visitors', 'clicked', 'paid']);
    expect(result.safety).toMatchObject({ status: 'pass' });
  });

  it('--since leaves out earlier cases and says so; a malformed day is a usage error (exit 2)', async () => {
    const t = db.setup();
    await t.fileCase({ title: 'Deploy check' });
    t.advance(3 * 24 * 60 * 60 * 1000);
    await t.fileCase({ title: 'Real case' });
    const { code, stdout } = await decide(['--since', '2026-11-04']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/cases filed since 2026-11-04/);
    expect(stdout).toMatch(/Keep collecting: 1 of 30 cases/);

    for (const bad of [['--since', 'last week'], ['--since', '2026-13-40'], ['--since']]) {
      const usage = await decide(bad);
      expect(usage.code, bad.join(' ')).toBe(2);
      expect(usage.stderr).toMatch(/Usage:/);
    }
  });
});

describe('npm run decide -- review | ok | violation', () => {
  it('review lists each ruling with its case, its deletion date and the exact commands to answer it', async () => {
    const t = db.setup();
    const filed = await t.ruledCase({ title: 'The Great Shower Affair' });
    const { code, stdout } = await decide(['review']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/1 ruling waits for review \(0 of 100 reviewed so far\)/);
    expect(stdout).toContain(`/cases/${filed.caseId}`);
    expect(stdout).toContain('The Great Shower Affair');
    expect(stdout).toMatch(/Charge: Said "five minutes away" while still in the shower/);
    expect(stdout).toMatch(/Ruling \(Split decision\): Order in the group chat/);
    expect(stdout).toMatch(/deleted on 2026-12-01 or the day after/);
    expect(stdout).toContain(`npm run decide -- ok ${filed.caseId}\n`);
    expect(stdout).toContain(`npm run decide -- violation ${filed.caseId} names_someone|serious`);
    for (const line of stdout.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('ok approves; the queue is then empty and the report counts it', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const ok = await decide(['ok', filed.caseId]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`Reviewed ${filed.caseId}: ok`));
    expect((await decide(['review'])).stdout).toMatch(/No rulings wait for review/);
    expect((await decide([])).stdout).toMatch(/Safety review: 1 of 1 rulings reviewed, 0 violations/);
  });

  it('an appeal ruling needs --with-appeal, and a stale ok (the appeal landed after the listing) is refused', async () => {
    const t = paidMode(db);
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    const listed = (await decide(['review'])).stdout;
    expect(listed).toMatch(/Appeal ruling \(Split decision\): Order in the group chat/);
    expect(listed).toContain(`npm run decide -- ok ${filed.caseId} --with-appeal`);

    const stale = await decide(['ok', filed.caseId]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/appeal ruling/i);
    expect(stale.stderr).toMatch(/run review again/i);
    expect((await decide(['ok', filed.caseId, '--with-appeal'])).code).toBe(0);
  });

  it('violation takes the case down and records the reason', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const res = await decide(['violation', filed.caseId, 'names_someone']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/taken down/i);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(410);
    expect((await decide([])).stdout).toMatch(/1 violation/);
  });

  it('a missing or unruled case is an error (exit 1) that changes nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const missing = await decide(['ok', 'nonexistentcase0']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/No case nonexistentcase0/);
    const unruled = await decide(['violation', filed.caseId, 'serious']);
    expect(unruled.code).toBe(1);
    expect(unruled.stderr).toMatch(/hasn't been ruled/);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
  });

  it('usage errors exit 2 with the usage; help exits 0', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    for (const argv of [
      ['ok'],
      ['violation', filed.caseId],
      ['violation', filed.caseId, 'mean'],
      ['violation', filed.caseId, 'ok'],
      ['frobnicate'],
      ['--frob'],
      ['ok', filed.caseId, 'extra'],
      ['violation', filed.caseId, 'serious', '--with-appeal'],
    ]) {
      const res = await decide(argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect(res.stderr, argv.join(' ')).toMatch(/Usage:/);
    }
    expect((await decide(['review'])).stdout).toContain(filed.caseId); // nothing was reviewed by the bad calls
    const help = await decide(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage:/);
  });

  it('strips terminal control and bidi characters from case and model text before printing it', async () => {
    // Escapes only: no raw control or bidi characters in this file.
    const [esc, bel, csi, rlo, pdf] = ['\u001b', '\u0007', '\u009b', '\u202e', '\u202c'];
    const t = db.setup({
      judge: async () =>
        JSON.stringify({
          verdict: 'guilty',
          ruling: `Order in the group chat. ${rlo}TRUOC${pdf} ${csi}31m ${'Guilty as charged, says the court. '.repeat(8)}`,
        }),
    });
    const filed = await t.ruledCase({ title: `Red ${esc}[31malert${esc}[0m ${rlo}desrever${pdf}${bel}`, charge: 'Ate the fries\r\nand left the bag' });
    const { stdout } = await decide(['review']);
    expect(stdout).toContain(filed.caseId);
    for (const bad of [esc, bel, csi, rlo, pdf, '\r']) expect(stdout).not.toContain(bad);
    expect(stdout).toMatch(/Red \[31malert\[0m desrever/);
    expect(stdout).toMatch(/Charge: Ate the fries and left the bag/);
    expect(stdout).toMatch(/Order in the group chat\. TRUOC 31m Guilty as charged/);
    expect(cleanText('a\u0000b\u009bc\u2066d\u2069e\nf \t g')).toBe('abcde f g');
  });
});

describe('the real command line', () => {
  const exec = promisify(execFile);
  const script = new URL('../scripts/decide.js', import.meta.url).pathname;
  // A clean environment: in-memory local data, and nothing from the shell that could point at a real database.
  const env = { PATH: process.env.PATH, PGLITE_DIR: 'memory://' };

  it('npm run decide runs scripts/decide.js', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.decide).toBe('node scripts/decide.js');
  });

  it('node scripts/decide.js prints the report from local PGlite, says which data it read, and exits 0', async () => {
    const { stdout, stderr } = await exec(process.execPath, [script], { env, timeout: 30_000 });
    expect(stdout).toMatch(/Decision: KEEP COLLECTING/);
    expect(stderr).toMatch(/No DATABASE_URL: reading local PGlite data/);
  }, 40_000);

  it('a usage error exits 2', async () => {
    const error = await exec(process.execPath, [script, 'violation'], { env, timeout: 30_000 }).catch((e) => e);
    expect(error.code).toBe(2);
    expect(error.stderr).toMatch(/Usage:/);
  }, 40_000);
});
