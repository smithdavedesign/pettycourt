// Group Chat Court HTTP app (Hono). `createApp(deps)` is what tests drive; the default export is the
// production app that Vercel's zero-config Hono detection deploys from this file (src/app.js).
//
//   POST /cases                    file a case          → 201 { caseId, summonsToken, juryToken, … }
//   GET  /summons/:token           summons page (HTML)  → 404 for any wrong token
//   POST /summons/:token/testimony defendant answers    → 201 once, then 409
//   POST /cases/:id/rule           call the judge       → 200 ruling | 409 | 422 | 502 | 503
//   GET  /cases/:id                results page (HTML), with the jury split and the card
//   GET  /jury/:token              jury page (HTML)     → 404 for any wrong token
//   POST /jury/:token/votes        juror votes          → 201 once per device, then 409
//   GET  /cases/:id/card.png       verdict card         → 1080×1350 PNG | 304 | 404
//   GET  /plaintiff/:token         plaintiff's private page: the links again, and delete
//   DELETE /cases/:id              a party deletes the case (Bearer plaintiff or summons token) → 200 | 401 | 404
//   GET  /deleted                  "the case is deleted" page
//   POST /reports { caseId, … }    anyone takes the case down → 201, then 200 | 404
//   POST /cases/:id/unlock         fake-door "Full trial · $3" click → 200 { clickId, charged: false } | 404 | 409
//   POST /cases/:id/unlock/email   optional email for that click → 200 | 400 | 404
//   GET  /cron/expire              the 30-day expiry job (Vercel Cron, daily) → 200 { deleted } | 401
// M4, the $3 appeal (when `payments` is configured; otherwise the M3 fake door stays):
//   POST /cases/:id/checkout       record a click, open a Stripe Checkout Session → 200 { clickId, url } | 409 | 502 | 503
//   GET  /appeals/:clickId         the payer's page (Stripe's success URL): fulfils, then the appeal form
//   POST /stripe/webhook           Stripe events (signed) → fulfil → 200 | 400 | 502 | 503
//   POST /cases/:id/appeal         the payer files the one appeal (Bearer click id) → 201 | 402 | 409 | …
//   POST /cases/:id/appeal/rule    hear a filed appeal again if the judge was down → 200 | 409 | 422 | 502
//   GET  /terms, GET /privacy      the legal pages
// M5, the decision's numbers (the report itself is the operator's `npm run decide`):
//   POST /visits { caseId }        the client script's once-per-browser visit to a case → 204 | 404
// Go-live (search, sharing, the Payment Link):
//   GET  /robots.txt, /sitemap.xml  crawl rules and the public pages (/, /terms, /privacy)
//   GET  /og.png                   the public pages' 1200×630 share image
//   POST /cases/:id/checkout       without Checkout but with STRIPE_PAYMENT_LINK: records the click and
//                                  answers the Payment Link with the click id as client_reference_id

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { cardEtag, cardModel, renderCardPng, renderSharePng } from './card.js';
import { createDeps } from './config.js';
import { APPELLANT_NAMES, parseRuling } from './judge.js';
import { DECLINE_MESSAGE, screen } from './scope.js';
import { pageMeta, robotsTxt, sitemapXml, SHARE_IMAGE } from './seo.js';
import { APPEAL_SIDES, JURY_VOTES, REPORT_REASONS, RETENTION_MS } from './store.js';
import {
  CLIENT_CSS,
  SIGNAL_URL,
  clientScript,
  COMMENT_MAX,
  EMAIL_MAX,
  EVIDENCE_MAX,
  NOTE_MAX,
  UNLOCK_INTEREST_MESSAGE,
  UNLOCK_MESSAGE,
  appealPage,
  casePage,
  deletedPage,
  homePage,
  juryPage,
  notFoundPage,
  plaintiffPage,
  privacyPage,
  summonsPage,
  takenDownPage,
  termsPage,
} from './views.js';

export { RETENTION_MS };
export const DEADLINE_MS = 24 * 60 * 60 * 1000;
export const LIMITS = {
  title: 120,
  charge: 280,
  testimony: 2000,
  comment: COMMENT_MAX,
  note: NOTE_MAX,
  email: EMAIL_MAX,
  evidence: EVIDENCE_MAX,
};
const MAX_BODY_BYTES = 16 * 1024;
// Stripe's events are a few KB, but a Checkout Session object can grow; a 413 would make Stripe retry forever.
const MAX_WEBHOOK_BYTES = 64 * 1024;
const WEBHOOK_PATH = '/stripe/webhook';
const STATIC_CACHE = 'public, max-age=3600';
// The share image never changes within a deployment.
const SHARE_CACHE = 'public, max-age=86400';
const COMMENTS_SHOWN = 50;
// Rendered cards kept per instance, one per case (~120 KB each): a card shared in a busy group chat
// renders once, not once per friend or link-preview bot. Deleting or expiring a case drops its entry.
const CARD_CACHE_SIZE = 32;
// A lightweight shape check, not RFC 5322: one @, no spaces, a dot in the domain.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One vote per device: the device is a random id in an HttpOnly cookie, scoped to the jury routes.
// Votes store sha256(case id, device id), never the id itself, so votes can't be linked across cases.
const DEVICE_COOKIE = 'pc_device';
const DEVICE_MAX_AGE_S = 400 * 24 * 60 * 60; // the longest Max-Age browsers honour
const voterKey = (caseId, device) => createHash('sha256').update(`${caseId}:${device}`).digest('base64url');

// Case ids are 12 random bytes and tokens 24, both base64url (16 and 32 characters). Anything else
// is rejected as not found before touching the database.
const newCaseId = () => randomBytes(12).toString('base64url');
const newToken = () => randomBytes(24).toString('base64url');
const CASE_ID = /^[A-Za-z0-9_-]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

const log = (...args) => console.error('[pettycourt]', ...args);

/** Read a JSON object body, or describe why not as [status, message]. */
async function readJsonObject(c) {
  const type = (c.req.header('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) return { fail: [415, 'Send JSON with Content-Type: application/json.'] };
  let body;
  try {
    body = await c.req.json();
  } catch {
    return { fail: [400, 'The request body is not valid JSON.'] };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { fail: [400, 'Send a JSON object.'] };
  return { body };
}

/** Validate one text field: trimmed, within its limit, required unless `optional`. */
function textField(body, name, max, { optional = false, label = name } = {}) {
  const value = body[name];
  if (value === undefined || value === null || value === '') {
    return optional ? { value: '' } : { error: `${label} is required (up to ${max} characters).` };
  }
  if (typeof value !== 'string') return { error: `${label} must be text.` };
  const trimmed = value.trim();
  if (!trimmed && !optional) return { error: `${label} is required (up to ${max} characters).` };
  if (trimmed.length > max) return { error: `${label} must be at most ${max} characters.` };
  return { value: trimmed };
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function caseFileFor(c) {
  return {
    title: c.title,
    charge: c.charge,
    plaintiffTestimony: c.plaintiffTestimony,
    defendantTestimony: c.defendantTestimony,
    defendantAppeared: c.defendantTestimony !== null,
  };
}

function rulingBody(c) {
  return {
    caseId: c.id,
    verdict: c.verdict,
    ruling: c.ruling,
    defaultJudgment: c.defaultJudgment,
    ruledAt: c.ruledAt.toISOString(),
  };
}

/** What the judge hears on appeal: the M1 case file plus the original ruling and the new evidence. */
function appealFileFor(c) {
  return {
    ...caseFileFor(c),
    appeal: {
      appellant: APPELLANT_NAMES[c.appealSide],
      newEvidence: c.appealEvidence,
      originalVerdict: c.verdict,
      originalRuling: c.ruling,
    },
  };
}

/** The appeal as the API reports it. A declined appeal's evidence isn't echoed back. */
function appealBody(c) {
  return {
    side: c.appealSide,
    evidence: c.appealDeclinedAt ? null : c.appealEvidence,
    filedAt: c.appealedAt.toISOString(),
    verdict: c.appealVerdict,
    ruling: c.appealRuling,
    ruledAt: c.appealRuledAt?.toISOString() ?? null,
    outcome: c.appealRuledAt ? (c.appealVerdict === c.verdict ? 'upheld' : 'overturned') : null,
    declined: Boolean(c.appealDeclinedAt),
  };
}

/** Weak comparison of an If-None-Match header against one ETag. */
function etagMatches(header, etag) {
  if (!header) return false;
  const opaque = (tag) => tag.trim().replace(/^W\//, '');
  return header.trim() === '*' || header.split(',').some((tag) => opaque(tag) === opaque(etag));
}

/** The credential of an `Authorization: Bearer <token>` header ('' if empty), or null without one. */
function bearerToken(c) {
  const match = /^Bearer(?:\s+(\S*))?$/i.exec((c.req.header('authorization') ?? '').trim());
  return match ? (match[1] ?? '') : null;
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
function sameSecret(given, expected) {
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   judge: import('./judge.js').Judge,
 *   now?: () => Date,
 *   renderCard?: (model: ReturnType<typeof cardModel>) => Promise<Uint8Array>,
 *   cardCache?: Map<string, { etag: string, png: Uint8Array }>,
 *   cronSecret?: string | null,
 *   payments?: ReturnType<typeof import('./payments.js').createStripe> | null,
 *   contactEmail?: string | null,
 *   publicOrigin?: string | null,
 *   paymentLink?: string | null,
 *   signal?: boolean,
 *   siteOrigin?: string | null,
 *   renderShare?: () => Promise<Uint8Array>,
 * }} deps  cronSecret: when set, /cron/expire requires it as a bearer token (Vercel Cron sends CRON_SECRET).
 *   payments: the Stripe client; without it (or without a contactEmail for the terms) the $3 appeal stays
 *   M3's fake door. publicOrigin: the https origin to build links from behind a TLS proxy (Render).
 *   Go-live: paymentLink, the Stripe Payment Link the Buy button opens when Checkout is off (the fake
 *   door stays without it either). signal: the client script sends RepoHQ's launch counts (production).
 *   siteOrigin: the canonical origin of the public pages (else publicOrigin, else the request's).
 */
export function createApp({
  store,
  judge,
  now = () => new Date(),
  renderCard = renderCardPng,
  cardCache = new Map(),
  cronSecret = null,
  payments: stripe = null,
  contactEmail = null,
  publicOrigin = null,
  paymentLink = null,
  signal = false,
  siteOrigin = null,
  renderShare = renderSharePng,
}) {
  const app = new Hono();
  // No money without a contact on the terms page (refunds are on request).
  const payments = contactEmail ? stripe : null;
  // How the $3 appeal is sold: Checkout (confirmed by Stripe) wins over the Payment Link (confirmed by hand).
  const checkoutMode = payments ? 'stripe' : paymentLink ? 'link' : null;
  const clientJs = clientScript({ signal });

  const declined = (c) => c.json({ error: DECLINE_MESSAGE, declined: true }, 422);
  const notFoundJson = (c) => c.json({ error: 'Not found.' }, 404);
  const origin = (c) => publicOrigin ?? new URL(c.req.url).origin;
  /** The origin the public pages, robots.txt and the sitemap name as canonical. */
  const canonical = (c) => siteOrigin ?? origin(c);
  const closedByDecline = (c) => c.json({ error: 'This case is closed: the court declined to hear it.' }, 409);
  const takenDown = (c) => c.json({ error: 'This case was taken down after a report.' }, 409);
  const alreadyAppealed = (c) => c.json({ error: 'This case has already been appealed. The appeal stands.' }, 409);
  const notRuledYet = (c) => c.json({ error: 'The appeal opens after the ruling.' }, 409);

  /** This browser's device id from its cookie, if it has a well-formed one. */
  const knownDevice = (c) => {
    const device = getCookie(c, DEVICE_COOKIE);
    return device && TOKEN.test(device) ? device : null;
  };

  /** The device id, issuing a new cookie when the browser has none (or a malformed one). */
  const deviceFor = (c) => {
    const known = knownDevice(c);
    if (known) return known;
    const device = newToken();
    setCookie(c, DEVICE_COOKIE, device, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/jury',
      maxAge: DEVICE_MAX_AGE_S,
      secure: origin(c).startsWith('https:'),
    });
    return device;
  };

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        // RepoHQ's counter is the only other origin, and only where the script sends to it (production).
        connectSrc: signal ? ["'self'", new URL(SIGNAL_URL).origin] : ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    }),
  );
  app.use('*', async (c, next) => {
    // Case pages change as the trial moves on and the API is never cacheable; static assets override this.
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const limitTo = (maxSize) =>
    bodyLimit({ maxSize, onError: (c) => c.json({ error: `Request body must be under ${maxSize / 1024} KB.` }, 413) });
  const apiLimit = limitTo(MAX_BODY_BYTES);
  const webhookLimit = limitTo(MAX_WEBHOOK_BYTES);
  app.use('*', (c, next) => (c.req.path === WEBHOOK_PATH ? webhookLimit : apiLimit)(c, next));

  app.onError((error, c) => {
    log('request failed:', error);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });
  app.notFound((c) => c.html(notFoundPage(), 404));

  app.get('/', (c) => c.html(homePage({ meta: pageMeta('home', canonical(c)) })));

  app.get('/app.js', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.body(clientJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  });

  // ── Go-live: search and sharing ───────────────────────────────────────────────────────────────────
  app.get('/robots.txt', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.text(robotsTxt(canonical(c)));
  });
  app.get('/sitemap.xml', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.body(sitemapXml(canonical(c)), 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });
  // Drawn with code (satori + resvg, like the verdict card) on the first request, then kept in memory.
  app.get(SHARE_IMAGE.path, async (c) => {
    const png = await renderShare();
    c.header('Cache-Control', SHARE_CACHE);
    return c.body(png, 200, { 'Content-Type': 'image/png' });
  });
  app.get('/app.css', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.body(CLIENT_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  app.post('/cases', async (c) => {
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const title = textField(body, 'title', LIMITS.title, { optional: true });
    const charge = textField(body, 'charge', LIMITS.charge);
    const testimony = textField(body, 'testimony', LIMITS.testimony);
    const invalid = [title, charge, testimony].find((f) => f.error);
    if (invalid) return c.json({ error: invalid.error }, 400);

    if (screen(title.value, charge.value, testimony.value).outOfScope) return declined(c);

    const createdAt = now();
    const created = await store.createCase({
      id: newCaseId(),
      summonsToken: newToken(),
      juryToken: newToken(),
      plaintiffToken: newToken(),
      title: title.value || truncate(charge.value, LIMITS.title),
      charge: charge.value,
      plaintiffTestimony: testimony.value,
      createdAt,
      deadlineAt: new Date(createdAt.getTime() + DEADLINE_MS),
    });
    return c.json(
      {
        caseId: created.id,
        summonsToken: created.summonsToken,
        juryToken: created.juryToken,
        plaintiffToken: created.plaintiffToken,
        caseUrl: `${origin(c)}/cases/${created.id}`,
        summonsUrl: `${origin(c)}/summons/${created.summonsToken}`,
        juryUrl: `${origin(c)}/jury/${created.juryToken}`,
        plaintiffUrl: `${origin(c)}/plaintiff/${created.plaintiffToken}`,
        deadlineAt: created.deadlineAt.toISOString(),
      },
      201,
    );
  });

  app.get('/plaintiff/:token', async (c) => {
    const token = c.req.param('token');
    const found = TOKEN.test(token) ? await store.getCaseByPlaintiff(token) : null;
    if (!found) return c.html(notFoundPage(), 404);
    if (found.reportedAt) return c.html(takenDownPage({ caseId: found.id, token }));
    return c.html(plaintiffPage(found, now(), { origin: origin(c) }));
  });

  app.get('/summons/:token', async (c) => {
    const token = c.req.param('token');
    const found = TOKEN.test(token) ? await store.getCaseBySummons(token) : null;
    if (!found) return c.html(notFoundPage(), 404);
    if (found.reportedAt) return c.html(takenDownPage({ caseId: found.id, token }));
    return c.html(summonsPage(found, now()));
  });

  app.post('/summons/:token/testimony', async (c) => {
    const token = c.req.param('token');
    if (!TOKEN.test(token)) return notFoundJson(c);
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const testimony = textField(body, 'testimony', LIMITS.testimony);
    if (testimony.error) return c.json({ error: testimony.error }, 400);
    if (screen(testimony.value).outOfScope) return declined(c);

    // One atomic conditional UPDATE: of two simultaneous answers exactly one lands.
    const stored = await store.submitDefendantTestimony(token, testimony.value, now());
    if (stored) return c.json({ caseId: stored.id, caseUrl: `${origin(c)}/cases/${stored.id}` }, 201);

    const existing = await store.getCaseBySummons(token);
    if (!existing) return notFoundJson(c);
    if (existing.reportedAt) return takenDown(c);
    if (existing.ruledAt) return c.json({ error: 'This case is closed: the court has already ruled.' }, 409);
    if (existing.declinedAt) return closedByDecline(c);
    return c.json({ error: 'The defendant has already testified. The first answer stands.' }, 409);
  });

  app.get('/cases/:id', async (c) => {
    const id = c.req.param('id');
    const found = CASE_ID.test(id) ? await store.getCase(id) : null;
    if (!found) return c.html(notFoundPage(), 404);
    if (found.reportedAt) return c.html(takenDownPage(), 410);
    // A declined case shows neither the jury nor the card.
    const [jury, comments] = found.declinedAt
      ? [null, []]
      : await Promise.all([store.getJury(id), store.listComments(id, COMMENTS_SHOWN)]);
    return c.html(casePage(found, now(), { jury, comments, origin: origin(c), checkout: checkoutMode }));
  });

  app.get('/cases/:id/card.png', async (c) => {
    const id = c.req.param('id');
    const found = CASE_ID.test(id) ? await store.getCase(id) : null;
    if (!found || found.declinedAt || found.reportedAt) return c.html(notFoundPage(), 404);

    const model = cardModel(found, await store.getJury(id), new URL(c.req.url).host);
    const etag = cardEtag(model);
    // Browsers keep the card but revalidate each time: an unchanged card costs a 304, not a render.
    c.header('Cache-Control', 'private, no-cache');
    c.header('ETag', etag);
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304);

    let cached = cardCache.get(id);
    if (cached?.etag !== etag) {
      cached = { etag, png: await renderCard(model) };
      cardCache.delete(id);
      cardCache.set(id, cached);
      if (cardCache.size > CARD_CACHE_SIZE) cardCache.delete(cardCache.keys().next().value);
    }
    return c.body(cached.png, 200, { 'Content-Type': 'image/png' });
  });

  app.get('/jury/:token', async (c) => {
    const token = c.req.param('token');
    const found = TOKEN.test(token) ? await store.getCaseByJury(token) : null;
    if (!found) return c.html(notFoundPage(), 404);
    if (found.reportedAt) return c.html(takenDownPage(), 410);
    const device = found.declinedAt ? null : knownDevice(c);
    const mine = device ? await store.getVote(found.id, voterKey(found.id, device)) : null;
    const jury = mine ? await store.getJury(found.id) : null;
    return c.html(juryPage(found, now(), { mine, jury }));
  });

  app.post('/jury/:token/votes', async (c) => {
    const token = c.req.param('token');
    if (!TOKEN.test(token)) return notFoundJson(c);
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const { vote } = body;
    if (typeof vote !== 'string' || !JURY_VOTES.includes(vote)) {
      return c.json({ error: `Vote must be one of: ${JURY_VOTES.join(', ')}.` }, 400);
    }
    const comment = textField(body, 'comment', LIMITS.comment, { optional: true, label: 'Comment' });
    if (comment.error) return c.json({ error: comment.error }, 400);
    const oneLine = comment.value.replace(/\s+/g, ' ');
    if (oneLine && screen(oneLine).outOfScope) return declined(c);

    const found = await store.getCaseByJury(token);
    if (!found) return notFoundJson(c);
    if (found.reportedAt) return takenDown(c);
    if (found.declinedAt) return closedByDecline(c);

    // One atomic INSERT … ON CONFLICT DO NOTHING: of two simultaneous votes from a device exactly one lands.
    const voter = voterKey(found.id, deviceFor(c));
    const stored = await store.castVote({ caseId: found.id, voter, vote, comment: oneLine || null, at: now() });
    const jury = await store.getJury(found.id);
    if (stored) {
      return c.json({ caseId: found.id, caseUrl: `${origin(c)}/cases/${found.id}`, vote: stored.vote, jury }, 201);
    }
    // Nothing stored: a repeat vote, or the case was declined, taken down or deleted meanwhile.
    const current = await store.getCase(found.id);
    if (!current) return notFoundJson(c);
    if (current.reportedAt) return takenDown(c);
    if (current.declinedAt) return closedByDecline(c);
    return c.json({ error: 'This device has already voted on this case. The first vote stands.', jury }, 409);
  });

  app.post('/cases/:id/rule', async (c) => {
    const id = c.req.param('id');
    const found = CASE_ID.test(id) ? await store.getCase(id) : null;
    if (!found) return notFoundJson(c);
    if (found.reportedAt) return takenDown(c);
    if (found.ruledAt) return c.json(rulingBody(found), 200);
    if (found.declinedAt) return declined(c);

    const at = now();
    const appeared = found.defendantTestimony !== null;
    if (!appeared && at < found.deadlineAt) {
      return c.json(
        {
          error: `The defendant has until ${found.deadlineAt.toISOString()} to answer. The judge rules after the defendant answers or the deadline passes.`,
          deadlineAt: found.deadlineAt.toISOString(),
        },
        409,
      );
    }

    // Defence in depth: re-screen everything in case the term list grew after filing.
    if (screen(found.title, found.charge, found.plaintiffTestimony, found.defendantTestimony).outOfScope) {
      await store.markDeclined(id, at);
      return declined(c);
    }

    let raw;
    try {
      raw = await judge(caseFileFor(found));
    } catch (error) {
      if (error?.code === 'JUDGE_NOT_CONFIGURED') {
        log(error.message);
        return c.json({ error: 'The judge is not available right now. Please try again later.' }, 503);
      }
      log('judge call failed:', error?.message);
      return c.json({ error: 'The judge could not be reached. Please try again in a minute.' }, 502);
    }

    const parsed = parseRuling(raw, { defaultJudgment: !appeared });
    if (!parsed.ok) {
      log('judge reply rejected:', parsed.reason);
      return c.json({ error: 'The judge returned an unreadable ruling. Please try again.' }, 502);
    }
    if (parsed.declined) {
      await store.markDeclined(id, at);
      return declined(c);
    }

    const saved = await store.saveRuling(id, {
      verdict: parsed.verdict,
      ruling: parsed.ruling,
      defaultJudgment: !appeared,
      defendantAppeared: appeared,
      at,
    });
    if (saved) return c.json(rulingBody(saved), 200);

    // Lost a race: another request ruled or declined first, the case was reported or deleted, or the
    // defendant answered mid-deliberation.
    const current = await store.getCase(id);
    if (!current) return notFoundJson(c);
    if (current.reportedAt) return takenDown(c);
    if (current.ruledAt) return c.json(rulingBody(current), 200);
    if (current.declinedAt) return declined(c);
    return c.json({ error: 'The defendant just answered. Call the judge again to hear both sides.' }, 409);
  });

  // Either party deletes the whole case: testimonies, ruling, votes, reports, clicks (cascade) and card.
  app.delete('/cases/:id', async (c) => {
    const token = bearerToken(c);
    if (token === null) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Send the plaintiff or summons token as Authorization: Bearer <token>.' }, 401);
    }
    const id = c.req.param('id');
    const deleted = CASE_ID.test(id) && TOKEN.test(token) ? await store.deleteCase(id, token) : null;
    if (!deleted) return notFoundJson(c);
    cardCache.delete(deleted);
    return c.json({ caseId: deleted, deleted: true }, 200);
  });

  app.get('/deleted', (c) => c.html(deletedPage()));

  // A report takes the case down at once for everyone; the parties can still delete it. The case id is
  // in the body, so declined pages (which must offer no action under /cases/) can carry the form too.
  app.post('/reports', async (c) => {
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const id = body.caseId;
    if (typeof id !== 'string' || !CASE_ID.test(id)) return notFoundJson(c);
    const { reason } = body;
    if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason)) {
      return c.json({ error: `Reason must be one of: ${REPORT_REASONS.join(', ')}.` }, 400);
    }
    const note = textField(body, 'note', LIMITS.note, { optional: true, label: 'Note' });
    if (note.error) return c.json({ error: note.error }, 400);

    if (await store.reportCase(id, { reason, note: note.value || null, at: now() })) {
      cardCache.delete(id);
      log(`case ${id} taken down after a report (${reason})`);
      return c.json({ caseId: id, reported: true }, 201);
    }
    if (!(await store.getCase(id))) return notFoundJson(c);
    return c.json({ caseId: id, reported: true }, 200);
  });

  // The fake door: one row per click, no payment provider anywhere in the app.
  app.post('/cases/:id/unlock', async (c) => {
    const id = c.req.param('id');
    if (!CASE_ID.test(id)) return notFoundJson(c);
    const { fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const clickId = newToken();
    if (await store.recordUnlockClick({ id: clickId, caseId: id, at: now() })) {
      const message = payments ? UNLOCK_INTEREST_MESSAGE : UNLOCK_MESSAGE;
      return c.json({ caseId: id, clickId, charged: false, message }, 200);
    }
    const found = await store.getCase(id);
    if (!found) return notFoundJson(c);
    return found.reportedAt ? takenDown(c) : closedByDecline(c);
  });

  app.post('/cases/:id/unlock/email', async (c) => {
    const id = c.req.param('id');
    if (!CASE_ID.test(id)) return notFoundJson(c);
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const { clickId } = body;
    if (typeof clickId !== 'string' || !TOKEN.test(clickId)) {
      return c.json({ error: 'clickId must be the id returned by the unlock click.' }, 400);
    }
    const email = textField(body, 'email', LIMITS.email, { label: 'Email' });
    if (email.error) return c.json({ error: email.error }, 400);
    if (!EMAIL.test(email.value)) return c.json({ error: 'Email must look like name@example.com.' }, 400);
    const saved = await store.saveUnlockEmail({ clickId, caseId: id, email: email.value, at: now() });
    if (!saved) return notFoundJson(c);
    return c.json({ caseId: id, saved: true }, 200);
  });

  // The 30-day expiry job, run daily by Vercel Cron (vercel.json). The cutoff comes from the server
  // clock only, so a caller can at most make it run early, which deletes nothing that shouldn't go.
  // That is why it still runs when CRON_SECRET isn't set; when it is set, it is required.
  app.get('/cron/expire', async (c) => {
    if (cronSecret) {
      const token = bearerToken(c);
      if (token === null || !sameSecret(token, cronSecret)) return c.json({ error: 'Unauthorized.' }, 401);
    }
    const cutoff = new Date(now().getTime() - RETENTION_MS);
    const ids = await store.deleteFiledBefore(cutoff);
    for (const id of ids) cardCache.delete(id);
    if (ids.length) log(`expiry: deleted ${ids.length} case(s) filed before ${cutoff.toISOString()}`);
    return c.json({ deleted: ids.length, cutoff: cutoff.toISOString() }, 200);
  });

  // ── M4: the $3 appeal ─────────────────────────────────────────────────────────────────────────────

  /** Why a case refused a checkout click (the last line covers a state change between the insert and this read). */
  const whyNoCheckout = (found) => {
    if (found.reportedAt) return 'This case was taken down after a report.';
    if (found.declinedAt) return 'This case is closed: the court declined to hear it.';
    if (!found.ruledAt) return 'The appeal opens after the ruling.';
    if (found.appealedAt) return 'This case has already been appealed.';
    if (found.paidAt) return "This case's appeal is already paid for.";
    return 'This case can’t take a payment right now.';
  };

  /**
   * Records a session Stripe says is paid against its click (and the case, if it's the first payment).
   * Idempotent: the webhook and the landing page both call it, in any order, as often as they like.
   * @param {Awaited<ReturnType<NonNullable<typeof payments>['getSession']>>} session
   */
  async function recordPayment(session) {
    if (!session.paid || !session.clickId) return;
    const marked = await store.markClickPaid({ clickId: session.clickId, sessionId: session.id, at: now() });
    if (marked) {
      // Two people paid for the case's one appeal: whoever doesn't file it is owed a refund.
      if (!marked.firstPayment) log(`case ${marked.caseId} has a second payment (Stripe session ${session.id}): one payer is owed a refund`);
      return;
    }
    if (!(await store.getClick(session.clickId))) {
      log(`payment for a case that no longer exists: refund Stripe session ${session.id}`);
    }
  }

  app.post('/cases/:id/checkout', async (c) => {
    const id = c.req.param('id');
    if (!CASE_ID.test(id)) return notFoundJson(c);
    const { fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    if (!checkoutMode) return c.json({ error: "Payments aren't switched on yet." }, 503);

    // The click is the M5 "clicked the paid unlock" metric, so it's stored before Stripe is asked.
    const clickId = newToken();
    if (!(await store.recordCheckoutClick({ id: clickId, caseId: id, at: now() }))) {
      const found = await store.getCase(id);
      return found ? c.json({ error: whyNoCheckout(found) }, 409) : notFoundJson(c);
    }
    if (checkoutMode === 'link') {
      // Go-live: Stripe's hosted Payment Link. The click id rides along as client_reference_id, so the
      // operator can match the payment to its click by hand and email the payer /appeals/<click id>.
      const url = new URL(paymentLink);
      url.searchParams.set('client_reference_id', clickId);
      return c.json({ caseId: id, clickId, url: url.href }, 200);
    }
    let session;
    try {
      session = await payments.createCheckout({ caseId: id, clickId, origin: origin(c), now: now() });
    } catch (error) {
      log('checkout failed:', error?.message);
      return c.json({ error: "The payment page couldn't be opened. Please try again in a minute." }, 502);
    }
    await store.attachCheckoutSession(clickId, session.id);
    return c.json({ caseId: id, clickId, url: session.url }, 200);
  });

  // Stripe's success URL. Fulfils on the way in (Stripe's documented pattern; the webhook does the same).
  app.get('/appeals/:token', async (c) => {
    const token = c.req.param('token');
    let click = TOKEN.test(token) ? await store.getClick(token) : null;
    // Only checkout clicks have an appellant page; a fake-door click never started a payment.
    if (!click || (!click.checkoutSessionId && !click.paidAt)) return c.html(notFoundPage(), 404);
    let checking = false;
    if (!click.paidAt && payments) {
      try {
        const session = await payments.getSession(click.checkoutSessionId);
        if (session.clickId === click.id) await recordPayment(session);
      } catch (error) {
        log('appeal page: could not check the payment:', error?.message);
        checking = true;
      }
      click = await store.getClick(token);
    }
    const found = click && (await store.getCase(click.caseId));
    if (!found) return c.html(notFoundPage(), 404);
    // A payer whose case was taken down can't appeal any more, so their page says how to get the $3 back.
    if (found.reportedAt) return c.html(takenDownPage({ refundTo: click.paidAt ? (contactEmail ?? '') : null }), 410);
    return c.html(appealPage(found, click, { contactEmail, checking, receiptLinks: checkoutMode !== 'link' }));
  });

  app.post(WEBHOOK_PATH, async (c) => {
    if (!payments) return notFoundJson(c);
    if (!payments.webhookConfigured) {
      log('stripe webhook: STRIPE_WEBHOOK_SECRET is not set, so the event was refused');
      return c.json({ error: 'The webhook is not configured.' }, 503);
    }
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const event = payments.readWebhook(raw, c.req.header('stripe-signature'), now());
    if (!event.ok) return c.json({ error: 'Bad signature.' }, 400);
    if (event.sessionId) {
      let session;
      try {
        session = await payments.getSession(event.sessionId);
      } catch (error) {
        // Stripe retries a failed delivery, so the payment is recorded on a later attempt.
        log('stripe webhook: could not read the session:', error?.message);
        return c.json({ error: 'Could not confirm the session. Retry later.' }, 502);
      }
      await recordPayment(session);
    }
    return c.json({ received: true }, 200);
  });

  /**
   * Hears a filed appeal: re-screen, call the judge, store the ruling once. Never throws for the judge.
   * @returns {Promise<{ kind: 'ruled' | 'declined', case: import('./store.js').Case }
   *   | { kind: 'failed', status: 502 | 503, error: string } | { kind: 'gone' } | { kind: 'down' }>}
   */
  async function hearAppeal(found) {
    const at = now();
    const decline = async () => {
      const marked = (await store.markAppealDeclined(found.id, at)) ?? (await store.getCase(found.id));
      return marked ? { kind: 'declined', case: marked } : { kind: 'gone' };
    };
    if (screen(found.title, found.charge, found.plaintiffTestimony, found.defendantTestimony, found.appealEvidence).outOfScope) {
      return decline();
    }

    let raw;
    try {
      raw = await judge(appealFileFor(found));
    } catch (error) {
      if (error?.code === 'JUDGE_NOT_CONFIGURED') {
        log(error.message);
        return { kind: 'failed', status: 503, error: 'The judge is not available right now. Please try again later.' };
      }
      log('appeal: judge call failed:', error?.message);
      return { kind: 'failed', status: 502, error: 'The judge could not be reached. Please try again in a minute.' };
    }
    const parsed = parseRuling(raw);
    if (!parsed.ok) {
      log('appeal: judge reply rejected:', parsed.reason);
      return { kind: 'failed', status: 502, error: 'The judge returned an unreadable ruling. Please try again.' };
    }
    if (parsed.declined) return decline();

    const saved = await store.saveAppealRuling(found.id, { verdict: parsed.verdict, ruling: parsed.ruling, at });
    if (saved) {
      cardCache.delete(found.id);
      return { kind: 'ruled', case: saved };
    }
    // Lost a race: heard or declined meanwhile, or the case was reported or deleted.
    const current = await store.getCase(found.id);
    if (!current) return { kind: 'gone' };
    if (current.reportedAt) return { kind: 'down' };
    if (current.appealRuledAt) return { kind: 'ruled', case: current };
    return { kind: 'declined', case: current };
  }

  app.post('/cases/:id/appeal', async (c) => {
    const id = c.req.param('id');
    if (!CASE_ID.test(id)) return notFoundJson(c);
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const found = await store.getCase(id);
    if (!found) return notFoundJson(c);
    if (found.reportedAt) return takenDown(c);
    if (found.declinedAt) return closedByDecline(c);
    if (!found.ruledAt) return notRuledYet(c);
    // Whether a case is paid is public (the case page says so), so this comes before any credential.
    if (!found.paidAt) {
      return c.json({ error: 'The appeal costs $3. Pay for it on the case page first.', caseUrl: `${origin(c)}/cases/${id}` }, 402);
    }
    const token = bearerToken(c);
    if (!token) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Send the appeal link’s id as Authorization: Bearer <id>.' }, 401);
    }
    const click = TOKEN.test(token) ? await store.getClick(token) : null;
    if (!click || click.caseId !== id || !click.paidAt) {
      return c.json({ error: 'Only the person who paid for this appeal can file it, from the page Stripe sent them back to.' }, 403);
    }
    if (found.appealedAt) return alreadyAppealed(c);

    const { side } = body;
    if (typeof side !== 'string' || !APPEAL_SIDES.includes(side)) {
      return c.json({ error: `Side must be one of: ${APPEAL_SIDES.join(', ')}.` }, 400);
    }
    const evidence = textField(body, 'evidence', LIMITS.evidence, { label: 'Evidence' });
    if (evidence.error) return c.json({ error: evidence.error }, 400);
    // Out-of-scope evidence is refused before anything is stored, so the paid appeal can still be used.
    if (screen(evidence.value).outOfScope) return declined(c);

    // One atomic conditional UPDATE: of two simultaneous appeals exactly one lands.
    const filed = await store.fileAppeal(id, { clickId: click.id, side, evidence: evidence.value, at: now() });
    if (!filed) {
      const current = await store.getCase(id);
      if (!current) return notFoundJson(c);
      if (current.reportedAt) return takenDown(c);
      return alreadyAppealed(c);
    }

    const heard = await hearAppeal(filed);
    if (heard.kind === 'gone') return notFoundJson(c);
    if (heard.kind === 'down') return takenDown(c);
    const reply = { caseId: id, caseUrl: `${origin(c)}/cases/${id}` };
    if (heard.kind === 'failed') return c.json({ ...reply, heard: false, appeal: appealBody(filed), error: heard.error }, 201);
    return c.json({ ...reply, heard: true, appeal: appealBody(heard.case) }, 201);
  });

  // Hears a filed appeal that the judge couldn't hear at filing time. Idempotent, like /rule.
  app.post('/cases/:id/appeal/rule', async (c) => {
    const id = c.req.param('id');
    const found = CASE_ID.test(id) ? await store.getCase(id) : null;
    if (!found) return notFoundJson(c);
    if (found.reportedAt) return takenDown(c);
    if (!found.appealedAt) return c.json({ error: 'No appeal has been filed on this case.' }, 409);
    if (found.appealRuledAt) return c.json({ caseId: id, appeal: appealBody(found) }, 200);
    if (found.appealDeclinedAt) return declined(c);

    const heard = await hearAppeal(found);
    if (heard.kind === 'gone') return notFoundJson(c);
    if (heard.kind === 'down') return takenDown(c);
    if (heard.kind === 'failed') return c.json({ error: heard.error }, heard.status);
    if (heard.kind === 'declined') return declined(c);
    return c.json({ caseId: id, appeal: appealBody(heard.case) }, 200);
  });

  // ── M5: visitors per case ─────────────────────────────────────────────────────────────────────────
  // The client script reports a browser's first visit to a case's page, summons or jury link (once per
  // browser, never the plaintiff's own); link-preview bots run no script, so they never get here. The case
  // only gains a count: no cookie, no per-visitor row. JSON-only like every POST, so other sites can't
  // send it without a preflight the app never grants.
  app.post('/visits', async (c) => {
    const { body, fail } = await readJsonObject(c);
    if (fail) return c.json({ error: fail[1] }, fail[0]);
    const id = body.caseId;
    if (typeof id !== 'string' || !CASE_ID.test(id)) return notFoundJson(c);
    if (!(await store.recordVisit(id))) return notFoundJson(c);
    return c.body(null, 204);
  });

  app.get('/terms', (c) => c.html(termsPage({ contactEmail, checkout: checkoutMode, meta: pageMeta('terms', canonical(c)) })));
  app.get('/privacy', (c) =>
    c.html(privacyPage({ contactEmail, checkout: checkoutMode, meta: pageMeta('privacy', canonical(c)) })),
  );

  return app;
}

const production = createDeps(process.env);
export default createApp({
  store: production.store,
  judge: production.judge,
  cronSecret: production.cronSecret,
  payments: production.payments,
  contactEmail: production.contactEmail,
  publicOrigin: production.publicOrigin,
  paymentLink: production.paymentLink,
  signal: production.signal,
  siteOrigin: production.siteOrigin,
});
