// Production server for a plain Node host: Render's free web service (render.yaml), the commercial-use
// host for live payments, since Vercel Hobby is non-commercial. Vercel doesn't use this file (it deploys
// src/app.js). Unlike scripts/dev.js it never falls back to PGlite or the stub judge.
//
// Render's free instances sleep when idle and its cron jobs are paid, so the 30-day expiry runs here:
// once at boot, before the first request is served (a waking instance is the only moment stale data
// could be read), then hourly while the instance is up.

import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { createDeps } from '../src/config.js';

export const EXPIRY_EVERY_MS = 60 * 60 * 1000;

const log = (...args) => console.error('[pettycourt]', ...args);

/**
 * @param {{ env?: Record<string, string | undefined>, deps?: ReturnType<typeof createDeps>, port?: number,
 *   hostname?: string, expireEveryMs?: number }} [options]
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export async function start({
  env = process.env,
  deps = createDeps(env),
  port = Number(env.PORT) || 3000,
  hostname = '0.0.0.0',
  expireEveryMs = EXPIRY_EVERY_MS,
} = {}) {
  const app = createApp({
    store: deps.store,
    judge: deps.judge,
    cronSecret: deps.cronSecret,
    payments: deps.payments,
    contactEmail: deps.contactEmail,
    publicOrigin: deps.publicOrigin,
  });

  // The same route Vercel Cron calls, so deletion (and the card-cache purge) has one code path.
  const expire = async () => {
    try {
      const init = deps.cronSecret ? { headers: { authorization: `Bearer ${deps.cronSecret}` } } : undefined;
      const res = await app.request('/cron/expire', init);
      if (!res.ok) log(`expiry run failed with HTTP ${res.status}`);
    } catch (error) {
      log('expiry run failed:', error?.message);
    }
  };

  await expire();
  const timer = setInterval(expire, expireEveryMs);
  timer.unref();

  const server = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname }, () => resolve(s));
  });
  const { port: bound } = server.address();
  return {
    url: `http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${bound}`,
    stop: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = createDeps(process.env);
  if (deps.dbKind === 'missing') log('DATABASE_URL is not set: every data request will fail.');
  if (deps.judgeKind === 'unconfigured') log('No LLM key: the judge answers 503.');
  if (deps.paymentsKind === 'no-contact') log('STRIPE_SECRET_KEY is set but CONTACT_EMAIL is not: payments stay off.');
  const { url } = await start({ deps });
  log(`Group Chat Court is in session on ${url} (payments: ${deps.paymentsKind})`);
}
