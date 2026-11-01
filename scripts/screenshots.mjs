// `npm run screenshots`: proof that the product does its job, with sample data. It starts the local app
// (scripts/dev.js, stub judge, PGlite in .data/screenshots-db), then:
//   1. the home page with a case being filed                     → file-a-case-{desktop,mobile}.png
//   2. a real trial in separate browsers: the plaintiff files, the defendant answers the summons, three
//      jurors vote, the judge rules                            → verdict-{desktop,mobile}.png
//   3. 29 more sample cases through the API, the app stopped, the rulings reviewed with the real command
//      line, then `npm run decide` and its output on a plain page → decision-{desktop,mobile}.png
// Chromium comes from CHROMIUM_PATH (never downloaded). Not part of `npm test`.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = `${root}docs/screenshots`;
const dataDir = `${root}.data/screenshots-db`;
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = devices['iPhone 13'];

if (!process.env.CHROMIUM_PATH) {
  console.error('Set CHROMIUM_PATH to a Chromium or Chrome binary; this script never downloads a browser.');
  process.exit(1);
}

// The app and the command line get a minimal environment: the throwaway data folder and nothing else from
// the shell, so they use the stub judge and never touch a real database or key.
const childEnv = (extra = {}) => ({ PATH: process.env.PATH, PGLITE_DIR: dataDir, ...extra });

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startApp(port) {
  const child = spawn(process.execPath, ['scripts/dev.js'], { cwd: root, env: childEnv({ PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    log: () => log,
    stop: async () => {
      child.kill('SIGINT');
      await exited;
    },
  };
}

async function waitUntilUp(url, app) {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the app didn't answer on ${url}:\n${app.log()}`);
}

/** Runs the real command line (`npm run decide -- …`) against the screenshot data. */
function decideCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/decide.js', ...args], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('exit', (code) => (code === 0 ? resolve(stdout.trimEnd()) : reject(new Error(`decide ${args.join(' ')} exited ${code}: ${stderr}`))));
  });
}

const THE_CASE = {
  title: 'The Great Shower Affair',
  charge: 'Said "five minutes away" while still in the shower',
  testimony:
    'We had 8pm tickets. At 7:52 I got "five minutes away". At 8:20 I got a photo of a towel. I watched the trailers alone and held a seat with my coat for forty minutes.',
  defence:
    '"Five minutes away" is a state of mind. I was mentally en route, the towel was proof of progress, and I brought the good snacks to make up for it.',
  jury: [
    ['guilty', 'Showers do not count as travel.'],
    ['guilty', 'The towel photo was a confession.'],
    ['not_guilty', 'Mentally en route is a valid mode of transport.'],
  ],
};

// The rest of the sample: petty charges with set outcomes, so the report has a known shape.
const MORE_CHARGES = [
  'Ate the last dumpling without asking the table',
  'Used my charger and gave it back at 3%',
  'Spoiled the finale in the group chat',
  'Took the window seat again',
  'Replied "k" to a three-paragraph message',
  'Left one sip of milk in the carton and put it back',
  'Turned the thermostat to 26 while I was out',
  'Booked the restaurant for 6pm "because it was free"',
  'Paused the film for a snack and never came back',
  'Answered my riddle by googling it',
  'Wore my hoodie to the gym without asking',
  'Muted the group chat during the birthday planning',
  'Put the empty ice tray back in the freezer',
  'Claimed the last slice was "basically crust"',
  'Started the series without me',
  'Liked my ex’s holiday photos at 2am',
  'Parked so close I had to climb in through the boot',
  'Called the pub quiz answer a "team effort"',
  'Ordered for the table and forgot my order',
  'Hid the remote in the fruit bowl',
  'Laughed at my karaoke before the chorus',
  'Declared the fridge shelf "shared" after I stocked it',
  'Sent a voice note longer than the film',
  'Unplugged the router mid-match',
  'Borrowed my umbrella during the one storm this year',
  'Told everyone the surprise party was a surprise party',
  'Put pineapple on the shared pizza order',
  'Set seven alarms and slept through all of them',
  'Took a "quick" shower that lasted forty minutes',
];

async function api(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok && res.status !== 204) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Files the 29 other sample cases and gives them answers, rulings, juries, visits and unlock clicks. */
async function fileSample(base) {
  const ruled = [];
  for (const [i, charge] of MORE_CHARGES.entries()) {
    const filed = await api(base, '/cases', { charge, testimony: 'The court has seen the group chat. It speaks for itself.' });
    if (i < 13) await api(base, `/summons/${filed.summonsToken}/testimony`, { testimony: 'I deny everything, and also it was a little bit funny.' });
    if (i < 6) {
      await api(base, `/cases/${filed.caseId}/rule`);
      ruled.push(filed.caseId);
    }
    // Each vote without a cookie is a new device, like a different friend's phone.
    const votes = i < 8 ? 2 : i < 12 ? 1 : 0;
    for (let v = 0; v < votes; v += 1) await api(base, `/jury/${filed.juryToken}/votes`, { vote: v % 2 ? 'not_guilty' : 'guilty' });
    // The visit beacon, as a friend's browser sends it when it first opens one of the case's links.
    const visits = i < 10 ? 3 : i < 16 ? 1 : 0;
    for (let v = 0; v < visits; v += 1) await api(base, '/visits', { caseId: filed.caseId });
    if (i === 3 || i === 17) await api(base, `/cases/${filed.caseId}/unlock`);
  }
  return ruled;
}

async function shoot(page, name) {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`saved docs/screenshots/${name}.png`);
}

/** The home page with the sample case typed in. */
async function fillFiling(page, base) {
  await page.goto(`${base}/`);
  await page.fill('input[name="title"]', THE_CASE.title);
  await page.fill('input[name="charge"]', THE_CASE.charge);
  await page.fill('textarea[name="testimony"]', THE_CASE.testimony);
}

async function trial(browser, base) {
  // The plaintiff files from the home page.
  const plaintiff = await browser.newContext(DESKTOP);
  const desk = await plaintiff.newPage();
  await fillFiling(desk, base);
  await shoot(desk, 'file-a-case-desktop');
  await desk.click('button:has-text("File the case")');
  await desk.waitForSelector('#filed:not([hidden])');
  const summonsUrl = await desk.inputValue('[data-field="summonsUrl"]');
  const juryUrl = await desk.inputValue('[data-field="juryUrl"]');
  const caseUrl = await desk.getAttribute('a[data-field="caseUrl"]', 'href');

  const phoneHome = await (await browser.newContext(PHONE)).newPage();
  await fillFiling(phoneHome, base);
  await shoot(phoneHome, 'file-a-case-mobile');

  // The defendant answers the summons on their phone.
  const defendant = await (await browser.newContext(PHONE)).newPage();
  await defendant.goto(summonsUrl);
  await defendant.fill('textarea[name="testimony"]', THE_CASE.defence);
  await defendant.click('button:has-text("Submit my testimony")');
  await defendant.waitForURL(/\/cases\//);

  // Three friends vote from the group chat, each on their own phone.
  for (const [vote, comment] of THE_CASE.jury) {
    const juror = await (await browser.newContext(PHONE)).newPage();
    await juror.goto(juryUrl);
    await juror.check(`input[name="vote"][value="${vote}"]`);
    await juror.fill('input[name="comment"]', comment);
    await juror.click('button:has-text("Cast my vote")');
    await juror.waitForSelector('text=Your vote');
  }

  // The plaintiff calls the judge on the case page (the page reloads with the ruling).
  await desk.goto(caseUrl);
  await desk.click('button:has-text("Call the judge")');
  await desk.waitForSelector('section.verdict h2');

  // The result: the case page scrolled to the jury's split, their comments and the verdict card.
  for (const [page, name] of [
    [await plaintiff.newPage(), 'verdict-desktop'],
    [await (await browser.newContext(PHONE)).newPage(), 'verdict-mobile'],
  ]) {
    await page.goto(caseUrl);
    await page.waitForFunction(() => document.querySelector('section.card img')?.complete);
    await page.evaluate(() => document.querySelector('section.jury').scrollIntoView({ block: 'start' }));
    await shoot(page, name);
  }
  return new URL(caseUrl).pathname.split('/').pop();
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A plain page showing a real command and its output, like a terminal. */
function terminalPage(command, output) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; background: #1d1a16; color: #f4efe6; font: 13px/1.45 ui-monospace, "DejaVu Sans Mono", Menlo, monospace; }
  main { padding: 20px 24px; }
  h1 { font: 600 14px system-ui, sans-serif; color: #c9bfae; margin: 0 0 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .cmd { color: #9fd18b; }
  /* The report is 80 columns wide: on a phone the type shrinks so each line stays one line, as in a terminal. */
  @media (max-width: 600px) { body { font-size: 7.4px; } main { padding: 12px; } h1 { font-size: 11px; } }
</style></head><body><main>
<h1>Group Chat Court · the M5 decision on a 30-case sample run (stub judge, payments off)</h1>
<pre><span class="cmd">$ ${escapeHtml(command)}</span>
${escapeHtml(output)}</pre>
</main></body></html>`;
}

async function main() {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const app = startApp(port);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  let ruled;
  try {
    await waitUntilUp(base, app);
    const trialCase = await trial(browser, base);
    ruled = [trialCase, ...(await fileSample(base))];
  } finally {
    await app.stop();
  }

  try {
    // The operator's safety review of every ruling, then the decision, with the real command line.
    for (const id of ruled) await decideCli(['ok', id]);
    const report = await decideCli([]);
    for (const [context, name] of [
      [DESKTOP, 'decision-desktop'],
      [PHONE, 'decision-mobile'],
    ]) {
      const page = await (await browser.newContext(context)).newPage();
      await page.setContent(terminalPage('npm run decide', report));
      await shoot(page, name);
    }
    console.log(`\n${report}`);
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
