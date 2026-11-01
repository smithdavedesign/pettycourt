// Turns environment variables into the app's dependencies. Values are read, never logged.
//   DATABASE_URL                Postgres (Neon) connection string. Required in production.
//   LLM_API_KEY | GOOGLE_API_KEY  key for the judge model (LLM_API_KEY wins).
//   LLM_BASE_URL, LLM_MODEL     optional: point the judge at another OpenAI-compatible endpoint.
//   CRON_SECRET                 optional: when set, /cron/expire requires it (Vercel Cron sends it).
//   STRIPE_SECRET_KEY           optional: switches the $3 appeal from M3's fake door to Stripe Checkout.
//   STRIPE_WEBHOOK_SECRET       optional: the signing secret that /stripe/webhook verifies.
//   CONTACT_EMAIL               the public address on the terms and privacy pages; payments need it.
//   PUBLIC_URL | RENDER_EXTERNAL_URL  optional https origin for links behind a TLS proxy (Render sets the latter).
//   PGLITE_DIR                  local only: where the PGlite fallback keeps its data.
// Go-live:
//   STRIPE_PAYMENT_LINK | NEXT_PUBLIC_STRIPE_PAYMENT_LINK  optional https Stripe Payment Link: the "Buy the
//                               appeal" button opens it when Checkout (STRIPE_SECRET_KEY) is off. Hidden without it.
//   NEXT_PUBLIC_DEPLOY_ENV, else NEXT_PUBLIC_VERCEL_ENV, else VERCEL_ENV  "production" turns on RepoHQ's
//                               launch counts (the client script's visit/activate/checkout signals).
//   VERCEL_PROJECT_PRODUCTION_URL  set by Vercel: the canonical host of the public pages when PUBLIC_URL isn't set.
// Production never falls back: no DATABASE_URL means data requests fail with a logged error, and no
// key means a 503 from the judge. Local mode (scripts/dev.js) uses PGlite and the stub judge instead.

import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { createJudge, stubJudge } from './judge.js';
import { createStripe } from './payments.js';
import { createStore } from './store.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An https URL, or null for anything else. */
function httpsUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** An https origin from a URL, or null for anything else. */
const httpsOrigin = (value) => httpsUrl(value)?.origin ?? null;

/** Adapt a PGlite instance to the store's `{ query, exec }` client. */
export function pgliteDb(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    exec: (sql) => pglite.exec(sql),
  };
}

function postgres(connectionString) {
  let pool;
  return {
    async connect() {
      pool ??= new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
      return {
        query: (sql, params) => pool.query(sql, params),
        // No params means the simple query protocol, which runs a multi-statement script in one round trip.
        exec: (sql) => pool.query(sql),
      };
    },
    close: async () => pool?.end(),
  };
}

function pglite(dataDir) {
  let instance;
  return {
    async connect() {
      if (!instance) {
        // A devDependency, loaded only in local mode so production never needs it.
        const { PGlite } = await import('@electric-sql/pglite');
        if (!dataDir.startsWith('memory://')) mkdirSync(dataDir, { recursive: true });
        instance = new PGlite(dataDir);
        await instance.waitReady;
      }
      return pgliteDb(instance);
    },
    close: async () => instance?.close(),
  };
}

const missingDatabase = {
  async connect() {
    throw new Error('DATABASE_URL is not set');
  },
  close: async () => {},
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ local?: boolean, pgliteDir?: string }} [options]
 * paymentsKind: 'stripe' (Checkout on), 'link' (the Payment Link's Buy button), 'off' (M3's fake door), or
 * 'no-contact' (a key but no CONTACT_EMAIL, so Checkout is off; a Payment Link still works).
 */
export function createDeps(env, { local = false, pgliteDir = env.PGLITE_DIR || '.data/pglite' } = {}) {
  let db;
  let dbKind;
  if (env.DATABASE_URL) [db, dbKind] = [postgres(env.DATABASE_URL), 'postgres'];
  else if (local) [db, dbKind] = [pglite(pgliteDir), 'pglite'];
  else [db, dbKind] = [missingDatabase, 'missing'];

  const apiKey = env.LLM_API_KEY || env.GOOGLE_API_KEY;
  let judge;
  let judgeKind;
  if (apiKey) {
    judge = createJudge({ apiKey, baseUrl: env.LLM_BASE_URL || undefined, model: env.LLM_MODEL || undefined });
    judgeKind = 'llm';
  } else if (local) {
    [judge, judgeKind] = [stubJudge, 'stub'];
  } else {
    // createJudge without a key throws JudgeNotConfiguredError on every call, which the app maps to 503.
    [judge, judgeKind] = [createJudge({}), 'unconfigured'];
  }

  // No money without a published contact: the terms promise refunds on request, so they need an address.
  const contact = (env.CONTACT_EMAIL ?? '').trim();
  const contactEmail = EMAIL.test(contact) ? contact : null;
  let payments = null;
  let paymentsKind = 'off';
  if (env.STRIPE_SECRET_KEY && contactEmail) {
    payments = createStripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET || null });
    paymentsKind = 'stripe';
  } else if (env.STRIPE_SECRET_KEY) {
    paymentsKind = 'no-contact';
  }
  // Go-live: a Stripe Payment Link needs no key. Checkout, when on, wins, because it confirms payments itself.
  const paymentLink = httpsUrl(env.STRIPE_PAYMENT_LINK || env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK)?.href ?? null;
  if (!payments && paymentLink) paymentsKind = 'link';

  const publicOrigin = httpsOrigin(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '');
  const vercelHost = (env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim();
  const deployEnv = env.NEXT_PUBLIC_DEPLOY_ENV || env.NEXT_PUBLIC_VERCEL_ENV || env.VERCEL_ENV || '';

  return {
    store: createStore(() => db.connect()),
    judge,
    cronSecret: env.CRON_SECRET || null,
    payments,
    contactEmail,
    publicOrigin,
    paymentLink,
    // RepoHQ's launch counts go out from the production deployment only, never from previews or local runs.
    signal: deployEnv === 'production',
    // The canonical origin of the public pages (canonical, og:url, sitemap): a preview deployment points at production.
    siteOrigin: publicOrigin ?? (vercelHost ? httpsOrigin(`https://${vercelHost}`) : null),
    dbKind,
    judgeKind,
    paymentsKind,
    close: () => db.close(),
  };
}
