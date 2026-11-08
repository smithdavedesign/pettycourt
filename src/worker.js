// The Cloudflare Worker (wrangler.jsonc; production since 2026-11-08). The same Hono app as Vercel's entry
// (src/app.js's default export) and Render's (scripts/serve.js), built once per isolate from the Worker's vars
// and secrets (src/config.js), with three Worker-specific pieces:
//   - Postgres: `pg` reaches Neon over the Workers socket API, and each request gets its own connection,
//     ended after the response (requestScopedPostgres): a Worker can't reuse another request's socket.
//   - The card renderer's wasm (resvg, satori's layout engine) and fonts are bundled at deploy and handed to
//     card.js (setCardAssets): a Worker can't read files or compile wasm at run time.
//   - The daily expiry runs from a Cron Trigger (`scheduled`) through the same /cron/expire route.
// First, before satori loads: its text shaper's wasm, compiled at deploy (src/harfbuzz-wasm.js).
import './harfbuzz-wasm.js';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import layoutWasm from 'satori/layout.wasm';
import latin400 from '@fontsource/lora/files/lora-latin-400-normal.woff2';
import latin700 from '@fontsource/lora/files/lora-latin-700-normal.woff2';
import latinExt400 from '@fontsource/lora/files/lora-latin-ext-400-normal.woff2';
import latinExt700 from '@fontsource/lora/files/lora-latin-ext-700-normal.woff2';
import cyrillic400 from '@fontsource/lora/files/lora-cyrillic-400-normal.woff2';
import cyrillic700 from '@fontsource/lora/files/lora-cyrillic-700-normal.woff2';
import vietnamese400 from '@fontsource/lora/files/lora-vietnamese-400-normal.woff2';
import vietnamese700 from '@fontsource/lora/files/lora-vietnamese-700-normal.woff2';
import { createApp } from './app.js';
import { setCardAssets } from './card.js';
import { createDeps, requestScopedPostgres } from './config.js';
import { EXPIRY_CRON, EXPIRY_PATH } from './schedule.js';

// card.js's FONT_SUBSETS × 400/700; test/worker.test.js checks this list against card.js.
const FONTS = [
  { subset: 'latin', weight: 400, data: latin400 },
  { subset: 'latin', weight: 700, data: latin700 },
  { subset: 'latin-ext', weight: 400, data: latinExt400 },
  { subset: 'latin-ext', weight: 700, data: latinExt700 },
  { subset: 'cyrillic', weight: 400, data: cyrillic400 },
  { subset: 'cyrillic', weight: 700, data: cyrillic700 },
  { subset: 'vietnamese', weight: 400, data: vietnamese400 },
  { subset: 'vietnamese', weight: 700, data: vietnamese700 },
];
setCardAssets(async () => ({ resvgWasm, layoutWasm, fonts: FONTS }));

let built = null;
function appFor(env) {
  if (!built) {
    let scoped = null;
    const deps = createDeps(env, { database: (url) => (scoped = requestScopedPostgres(url)) });
    const app = createApp({
      store: deps.store,
      judge: deps.judge,
      cronSecret: deps.cronSecret,
      payments: deps.payments,
      contactEmail: deps.contactEmail,
      publicOrigin: deps.publicOrigin,
      paymentLink: deps.paymentLink,
      signal: deps.signal,
      siteOrigin: deps.siteOrigin,
    });
    // Without DATABASE_URL there's nothing to scope: data requests fail with the app's logged 500.
    const run = (fn, ctx) => (scoped ? scoped.run(fn, (p) => ctx.waitUntil(p)) : fn());
    built = { app, run, cronSecret: deps.cronSecret };
  }
  return built;
}

export default {
  fetch(request, env, ctx) {
    const { app, run } = appFor(env);
    return run(() => app.fetch(request, env, ctx), ctx);
  },
  async scheduled(controller, env, ctx) {
    if (controller.cron !== EXPIRY_CRON) throw new Error(`no job is scheduled for "${controller.cron}"`);
    const { app, run, cronSecret } = appFor(env);
    const headers = cronSecret ? { authorization: `Bearer ${cronSecret}` } : {};
    const res = await run(() => app.fetch(new Request(`https://scheduler.invalid${EXPIRY_PATH}`, { headers }), env, ctx), ctx);
    const body = await res.text();
    if (!res.ok) throw new Error(`${EXPIRY_PATH} answered ${res.status}: ${body.slice(0, 200)}`);
    console.log(`scheduled ${EXPIRY_PATH}: ${body.slice(0, 200)}`);
  },
};
