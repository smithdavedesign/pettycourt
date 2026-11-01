// `npm run screenshots`: proof that the launch-ready product does its job, with sample data. It starts the
// local app (scripts/dev.js, stub judge, PGlite in .data/screenshots-db, and a placeholder
// STRIPE_PAYMENT_LINK so the Buy button shows), waits until it answers, then runs a real trial in
// separate browsers and saves, each on a desktop (1280×800) and an iPhone 13, viewport only:
//   1. the start page with a petty case typed in, about to be filed           → home-{desktop,mobile}.png
//   2. the summons the other side opens, with their answer typed in          → summons-{desktop,mobile}.png
//   3. the result after three jurors voted and the judge ruled: on a desktop the verdict card and the
//      footer's links, on the phone the "Buy the appeal · $3" button and the jury → verdict-{desktop,mobile}.png
// Then it stops the app and deletes the data. Chromium comes from CHROMIUM_PATH (never downloaded).
// The app runs as a local, non-production build, so it sends no RepoHQ launch counts (and Playwright's
// navigator.webdriver would stop them anyway). Not part of `npm test`.

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
// A placeholder: the real Payment Link only ever comes from the deployment's environment.
const PLACEHOLDER_PAYMENT_LINK = 'https://example.com/pay';

if (!process.env.CHROMIUM_PATH) {
  console.error('Set CHROMIUM_PATH to a Chromium or Chrome binary; this script never downloads a browser.');
  process.exit(1);
}

// The app gets a minimal environment: the throwaway data folder, the port and the placeholder link, and
// nothing else from the shell, so it uses the stub judge and never touches a real database or key.
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
  const env = childEnv({ PORT: String(port), STRIPE_PAYMENT_LINK: PLACEHOLDER_PAYMENT_LINK });
  const child = spawn(process.execPath, ['scripts/dev.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function shoot(page, name) {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`saved docs/screenshots/${name}.png`);
}

/**
 * Fails the run when something a screenshot is meant to prove isn't inside its viewport: wholly, or at
 * least `share` of its height.
 */
async function expectInView(page, selector, what, share = 1) {
  const inView = await page.evaluate(
    ([s, min]) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && shown >= min * r.height - 0.5;
    },
    [selector, share],
  );
  if (!inView) throw new Error(`${what} isn't in view on ${page.url()}`);
}

/** The home page with the sample case typed in. */
async function fillFiling(page, base) {
  await page.goto(`${base}/`);
  await page.fill('input[name="title"]', THE_CASE.title);
  await page.fill('input[name="charge"]', THE_CASE.charge);
  await page.fill('textarea[name="testimony"]', THE_CASE.testimony);
}

async function trial(browser, base) {
  // 1. The start page: the plaintiff types the case in, on a desktop and on a phone.
  const plaintiff = await browser.newContext(DESKTOP);
  const desk = await plaintiff.newPage();
  await fillFiling(desk, base);
  await shoot(desk, 'home-desktop');

  const phoneHome = await (await browser.newContext(PHONE)).newPage();
  await fillFiling(phoneHome, base);
  await phoneHome.locator('textarea[name="testimony"]').scrollIntoViewIfNeeded();
  await shoot(phoneHome, 'home-mobile');

  // The plaintiff files it: the core action.
  await desk.click('button:has-text("File the case")');
  await desk.waitForSelector('#filed:not([hidden])');
  const summonsUrl = await desk.inputValue('[data-field="summonsUrl"]');
  const juryUrl = await desk.inputValue('[data-field="juryUrl"]');
  const caseUrl = await desk.getAttribute('a[data-field="caseUrl"]', 'href');

  // 2. The other side opens the summons and types an answer: on a desktop (not sent), then on the phone (sent).
  const deskDefendant = await (await browser.newContext(DESKTOP)).newPage();
  await deskDefendant.goto(summonsUrl);
  await deskDefendant.fill('textarea[name="testimony"]', THE_CASE.defence);
  await deskDefendant.locator('h2:has-text("The charge")').scrollIntoViewIfNeeded();
  await shoot(deskDefendant, 'summons-desktop');

  const defendant = await (await browser.newContext(PHONE)).newPage();
  await defendant.goto(summonsUrl);
  await defendant.fill('textarea[name="testimony"]', THE_CASE.defence);
  await defendant.evaluate(() => document.querySelector('textarea[name="testimony"]').scrollIntoView({ block: 'center' }));
  await shoot(defendant, 'summons-mobile');
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

  // 3. The result. On a desktop, the bottom of the case page: the verdict card (verdict stamp, ruling and
  //    jury split) and the footer's links. On the phone, the Buy button above the jury's split and comments.
  const result = await plaintiff.newPage();
  await result.goto(caseUrl);
  await result.waitForFunction(() => document.querySelector('section.card img')?.complete);
  await result.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expectInView(result, 'section.card img', 'the verdict card', 0.85);
  for (const href of ['/terms', '/privacy']) await expectInView(result, `footer a[href="${href}"]`, `the footer link to ${href}`);
  await shoot(result, 'verdict-desktop');

  const phoneResult = await (await browser.newContext(PHONE)).newPage();
  await phoneResult.goto(caseUrl);
  await phoneResult.waitForFunction(() => document.querySelector('section.card img')?.complete);
  await phoneResult.evaluate(() => document.querySelector('section.unlock').scrollIntoView({ block: 'start' }));
  await expectInView(phoneResult, 'form[data-buy] button', 'the Buy button');
  await expectInView(phoneResult, 'section.jury .split', 'the jury split');
  await shoot(phoneResult, 'verdict-mobile');
}

async function main() {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const app = startApp(port);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    await waitUntilUp(base, app);
    await trial(browser, base);
  } finally {
    await browser.close();
    await app.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
