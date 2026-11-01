// Local runner: `npm run dev` / `npm start`. Not used on Vercel (it deploys src/app.js) or on Render
// (scripts/serve.js). Without DATABASE_URL it keeps data in PGlite under .data/; without an LLM key it
// uses the stub judge.

import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { createDeps } from '../src/config.js';

const deps = createDeps(process.env, { local: true });
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
const port = Number(process.env.PORT) || 3000;

if (deps.dbKind === 'pglite') console.log('No DATABASE_URL: using local PGlite data in .data/ (or PGLITE_DIR).');
if (deps.judgeKind === 'stub') console.log('No LLM key: using the stub judge (canned rulings).');
if (deps.paymentsKind === 'off') console.log('No STRIPE_SECRET_KEY or STRIPE_PAYMENT_LINK: "Full trial · $3" is the M3 fake door.');
if (deps.paymentsKind === 'link') console.log('STRIPE_PAYMENT_LINK is set: "Buy the appeal · $3" opens it.');
if (deps.paymentsKind === 'no-contact') console.log('STRIPE_SECRET_KEY is set but CONTACT_EMAIL is not: payments stay off.');
if (deps.signal) console.log('Production deploy env: the pages send RepoHQ launch counts.');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Group Chat Court is in session at http://localhost:${info.port}`);
});
