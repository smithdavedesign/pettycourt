import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { pgliteDb } from '../src/config.js';

export const T0 = new Date('2026-11-01T12:00:00.000Z');
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** Flip one character so the token has the right shape but matches nothing. */
export function nearMiss(token) {
  const last = token.at(-1);
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** Rows in every table that belong to one case, for "nothing is left" assertions. */
export const CASE_TABLES = [
  ['cases', 'id'],
  ['votes', 'case_id'],
  ['reports', 'case_id'],
  ['unlock_clicks', 'case_id'],
];

/** A fresh device id, shaped like the ones the server issues in the `pc_device` cookie. */
export const newDevice = () => randomBytes(24).toString('base64url');

/** Width and height from a PNG's IHDR chunk; throws if the bytes aren't a PNG. */
export function pngSize(bytes) {
  const buf = Buffer.from(bytes);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG without IHDR first');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A ruling of exactly `n` words. */
export function words(n, word = 'objection') {
  return Array.from({ length: n }, () => word).join(' ');
}

export const GOOD_RULING =
  'Order in the group chat. Having weighed the testimony of the Plaintiff and the rebuttal of the Defendant, ' +
  'this court finds that "five minutes away" is a statement of hope, not of fact. The Defendant is sentenced ' +
  'to arrive first at the next three outings and to bring snacks. The Plaintiff is reminded that sighing loudly ' +
  'is not admissible evidence. Court is adjourned.';

/** The appeal ruling the mocked judge gives in M4 tests: overturns a split into not guilty. */
export const APPEAL_RULING =
  'Order in the group chat, on appeal. The Defendant returns with a screenshot showing the taxi was booked ' +
  'before the shower began, which this court accepts as proof of intent to travel. The original split decision ' +
  'is overturned: the Defendant is not guilty of false arrival claims, though the court notes the shower ran long. ' +
  'The Plaintiff buys the popcorn next time. Court is adjourned.';

/** The appellant's new evidence in M4 tests. */
export const NEW_EVIDENCE = 'Exhibit A: the taxi app shows I booked the ride before I got in the shower.';

export function judgeReply(verdict = 'split', ruling = GOOD_RULING) {
  return JSON.stringify({ verdict, ruling });
}

/** One in-memory Postgres per test file; each `setup()` gets a fresh app, clock and judge mock on it. */
export function testDatabase() {
  let pg;
  let store;
  return {
    async open() {
      pg = new PGlite();
      await pg.waitReady;
      store = createStore(async () => pgliteDb(pg));
      await store.ready();
      return this;
    },
    async close() {
      await pg?.close();
    },
    get store() {
      return store;
    },
    /** Raw SQL for assertions that bypass the app. */
    async sql(text, params = []) {
      return (await pg.query(text, params)).rows;
    },
    /** How many rows each table holds for this case id, e.g. { cases: 1, votes: 3, reports: 0, unlock_clicks: 1 }. */
    async rowsFor(caseId) {
      const counts = {};
      for (const [table, column] of CASE_TABLES) {
        const [row] = await this.sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [caseId]);
        counts[table] = row.n;
      }
      return counts;
    },
    setup({ judge, renderCard, cardCache, cronSecret, payments, contactEmail, publicOrigin, paymentLink, signal, siteOrigin } = {}) {
      const clock = { now: new Date(T0) };
      const judgeMock = vi.fn(judge ?? (async () => judgeReply()));
      const app = createApp({
        store,
        judge: judgeMock,
        now: () => clock.now,
        ...(renderCard ? { renderCard } : {}),
        ...(cardCache ? { cardCache } : {}),
        ...(cronSecret ? { cronSecret } : {}),
        ...(payments ? { payments } : {}),
        ...(contactEmail ? { contactEmail } : {}),
        ...(publicOrigin ? { publicOrigin } : {}),
        // Go-live: the Payment Link, RepoHQ's launch counts and the canonical origin.
        ...(paymentLink ? { paymentLink } : {}),
        ...(signal ? { signal } : {}),
        ...(siteOrigin ? { siteOrigin } : {}),
      });
      const request = (path, init) => app.request(path, init);
      const post = (path, body, headers = {}) =>
        request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        });
      const get = (path, headers) => request(path, headers ? { headers } : undefined);
      const deviceCookie = (device) => (device ? { cookie: `pc_device=${device}` } : {});
      /** Cast a jury vote; `device` becomes the pc_device cookie (omit it to vote as a cookieless browser). */
      const vote = (juryToken, body, device) => post(`/jury/${juryToken}/votes`, body, deviceCookie(device));
      /** The jury page as seen from `device`. */
      const juryPage = (juryToken, device) => get(`/jury/${juryToken}`, deviceCookie(device));
      async function fileCase(fields = {}) {
        const res = await post('/cases', {
          charge: 'Said "five minutes away" while still in the shower',
          testimony: 'I waited forty minutes outside the cinema and missed the trailers.',
          ...fields,
        });
        if (res.status !== 201) throw new Error(`fileCase failed with ${res.status}: ${await res.text()}`);
        return res.json();
      }
      async function answer(summonsToken, testimony = 'The shower was part of the journey. I was mentally en route.') {
        return post(`/summons/${summonsToken}/testimony`, { testimony });
      }
      const advance = (ms) => {
        clock.now = new Date(clock.now.getTime() + ms);
      };
      /** DELETE /cases/:id with `token` as the bearer credential (omit it to send no Authorization header). */
      const deleteCase = (caseId, token, { scheme = 'Bearer' } = {}) =>
        request(`/cases/${caseId}`, {
          method: 'DELETE',
          headers: token === undefined ? {} : { authorization: `${scheme} ${token}` },
        });
      const report = (caseId, body = { reason: 'names_someone' }) => post('/reports', { caseId, ...body });
      const unlock = (caseId) => post(`/cases/${caseId}/unlock`, {});
      const unlockEmail = (caseId, body) => post(`/cases/${caseId}/unlock/email`, body);
      /** Run the expiry job the way Vercel Cron does: a GET, with the secret as a bearer token if given. */
      const expire = (secret) => get('/cron/expire', secret === undefined ? undefined : { authorization: `Bearer ${secret}` });
      /** Start a Stripe checkout for the $3 appeal (M4). */
      const checkout = (caseId) => post(`/cases/${caseId}/checkout`, {});
      /** File the appeal; `token` is the payer's click id, sent as the bearer credential (omit it to send none). */
      const appeal = (caseId, token, body = { side: 'defendant', evidence: NEW_EVIDENCE }) =>
        post(`/cases/${caseId}/appeal`, body, token === undefined ? {} : { authorization: `Bearer ${token}` });
      const hearAppeal = (caseId) => post(`/cases/${caseId}/appeal/rule`);
      /** Deliver a Stripe webhook: the raw body and its Stripe-Signature header. */
      const webhook = ({ body, signature }) =>
        request('/stripe/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(signature === undefined ? {} : { 'stripe-signature': signature }) },
          body,
        });
      /** The current fake time in whole seconds, as Stripe stamps webhook signatures. */
      const nowSeconds = () => Math.floor(clock.now.getTime() / 1000);
      /** File, answer and rule a case in one go; returns the filing response. */
      async function ruledCase(fields = {}) {
        const filed = await fileCase(fields);
        await answer(filed.summonsToken);
        const res = await post(`/cases/${filed.caseId}/rule`);
        if (res.status !== 200) throw new Error(`rule failed with ${res.status}: ${await res.text()}`);
        return filed;
      }
      return {
        app,
        clock,
        advance,
        judge: judgeMock,
        request,
        post,
        get,
        fileCase,
        answer,
        ruledCase,
        vote,
        juryPage,
        deleteCase,
        report,
        unlock,
        unlockEmail,
        expire,
        checkout,
        appeal,
        hearAppeal,
        webhook,
        nowSeconds,
      };
    },
  };
}
