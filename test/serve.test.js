// M4: the production Node entry for a commercial-use host (scripts/serve.js, deployed by render.yaml).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeps } from '../src/config.js';
import { EXPIRY_EVERY_MS, start } from '../scripts/serve.js';
import { DAY, newDevice } from './helpers.js';

const FAKE_CRON_SECRET = ['cron', 'Qw3'.repeat(11)].join('-');
const running = [];
afterEach(async () => {
  while (running.length) await running.pop()();
  vi.restoreAllMocks();
});

/** Local deps (in-memory PGlite, stub judge) with production-style env on top. */
function localDeps(env = {}) {
  const deps = createDeps(env, { local: true, pgliteDir: 'memory://' });
  running.push(() => deps.close());
  return deps;
}

async function boot(options) {
  const server = await start({ port: 0, hostname: '127.0.0.1', ...options });
  running.push(() => server.stop()); // popped first: stop serving before the database closes
  return server;
}

/** A case filed `daysAgo` days ago, written through the store. */
async function oldCase(deps, daysAgo) {
  const createdAt = new Date(Date.now() - daysAgo * DAY);
  const id = newDevice().slice(0, 16);
  await deps.store.createCase({
    id,
    summonsToken: newDevice(),
    juryToken: newDevice(),
    plaintiffToken: newDevice(),
    title: `Filed ${daysAgo} days ago`,
    charge: 'Took the window seat again',
    plaintiffTestimony: 'Every single flight.',
    createdAt,
    deadlineAt: new Date(createdAt.getTime() + DAY),
  });
  return id;
}

describe('scripts/serve.js start()', () => {
  it('runs the 30-day expiry at boot, before serving, then serves the app over HTTP', async () => {
    const deps = localDeps();
    const expired = await oldCase(deps, 31);
    const kept = await oldCase(deps, 29);
    const server = await boot({ deps });

    expect(await deps.store.getCase(expired)).toBeNull();
    expect(await deps.store.getCase(kept)).not.toBeNull();
    const home = await fetch(`${server.url}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('data-api="/cases"');
    expect((await fetch(`${server.url}/cases/${kept}`)).status).toBe(200);
  });

  it('keeps running the expiry while it is up', async () => {
    const deps = localDeps();
    const server = await boot({ deps, expireEveryMs: 40 });
    const later = await oldCase(deps, 31);
    await vi.waitFor(async () => expect(await deps.store.getCase(later)).toBeNull(), { timeout: 3000, interval: 20 });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(EXPIRY_EVERY_MS).toBe(60 * 60 * 1000);
  });

  it('sends CRON_SECRET to its own expiry job when one is set', async () => {
    const deps = localDeps({ CRON_SECRET: FAKE_CRON_SECRET });
    const expired = await oldCase(deps, 31);
    const server = await boot({ deps });
    expect(await deps.store.getCase(expired)).toBeNull();
    // Outsiders still need the secret.
    expect((await fetch(`${server.url}/cron/expire`)).status).toBe(401);
  });

  it('builds https links from the public origin behind the host’s TLS proxy', async () => {
    const deps = localDeps({ RENDER_EXTERNAL_URL: 'https://pettycourt.onrender.com' });
    const server = await boot({ deps });
    const res = await fetch(`${server.url}/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ charge: 'Ate my fries', testimony: 'All of them.' }),
    });
    expect(res.status).toBe(201);
    const filed = await res.json();
    for (const key of ['caseUrl', 'summonsUrl', 'juryUrl', 'plaintiffUrl']) {
      expect(filed[key].startsWith('https://pettycourt.onrender.com/'), key).toBe(true);
    }
    const vote = await fetch(`${server.url}/jury/${filed.juryToken}/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vote: 'guilty' }),
    });
    expect(vote.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
  });

  it('still serves when the database is unreachable at boot, and logs why the expiry failed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await boot({ env: {} });
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect(errors.mock.calls.flat().map(String).join(' ')).toMatch(/expiry/i);
  });
});

describe('render.yaml', () => {
  const yaml = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');

  it('deploys one free Node web service that runs scripts/serve.js', () => {
    expect(yaml).toMatch(/^\s*- type: web$/m);
    expect(yaml).toMatch(/^\s*runtime: node$/m);
    expect(yaml).toMatch(/^\s*plan: free$/m);
    expect(yaml).toMatch(/^\s*startCommand: node scripts\/serve\.js$/m);
    expect(yaml).toMatch(/^\s*buildCommand: npm ci --omit=dev --ignore-scripts$/m);
    expect(yaml).toMatch(/^\s*healthCheckPath: \/$/m);
  });

  it('names every secret without a value (sync: false), and has no cron service (Render charges for cron)', () => {
    for (const key of ['DATABASE_URL', 'GOOGLE_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CONTACT_EMAIL']) {
      expect(yaml).toMatch(new RegExp(`- key: ${key}\\n\\s+sync: false`));
    }
    expect(yaml).toMatch(/- key: CRON_SECRET\n\s+generateValue: true/);
    expect(yaml).not.toMatch(/value:/);
    expect(yaml).not.toMatch(/type: cron/);
  });
});
