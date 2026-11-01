// Stripe Checkout for the $3 appeal, over Stripe's REST API with `fetch` (no SDK: two calls and a
// signature check). The only file in src/ that knows a payment provider; the app gets it injected as
// `payments` (config.js), so the M3 unlock click can't reach it.
//
//   createCheckout  POST /v1/checkout/sessions      a hosted Checkout page for one appeal on one case
//   getSession      GET  /v1/checkout/sessions/:id  what fulfilment trusts: re-read, never the webhook body
//   readWebhook     Stripe-Signature check (HMAC-SHA256 over "t.rawBody", 300 s tolerance)
//
// Stripe's replies are untrusted input like the model's: ids and URLs are shape-checked before use.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const APPEAL_PRICE_CENTS = 300;
export const APPEAL_CURRENCY = 'usd';
export const APPEAL_PRICE_LABEL = '$3.00';
export const APPEAL_PRODUCT = 'Group Chat Court: one appeal';
// Checkout links stay open an hour (Stripe's minimum is 30 minutes), which keeps the window for two
// people paying for the same case's one appeal short.
export const CHECKOUT_TTL_S = 60 * 60;
export const WEBHOOK_TOLERANCE_S = 300;
/** Webhook events that mean "this session may now be paid"; everything else is acknowledged and ignored. */
export const FULFIL_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const DEFAULT_TIMEOUT_MS = 10_000;

const SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]+$/;
const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
const CLICK_ID = /^[A-Za-z0-9_-]{32}$/;

/**
 * Checks a `Stripe-Signature` header (`t=<unix s>,v1=<hex>[,v1=…][,v0=…]`) against the raw body.
 * Any matching v1 passes (Stripe sends several while a secret is being rotated); v0 is ignored.
 * @param {string | Uint8Array} payload  the raw request body, exactly as received
 * @param {string | null | undefined} header
 * @param {string} secret  the endpoint's signing secret
 * @param {{ nowMs: number, toleranceS?: number }} clock
 */
export function verifySignature(payload, header, secret, { nowMs, toleranceS = WEBHOOK_TOLERANCE_S }) {
  if (!secret || typeof header !== 'string') return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && /^\d+$/.test(value ?? '')) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value ?? '')) signatures.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

/** Bracketed form fields, the way Stripe's API takes nested parameters. */
function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body.toString();
}

/**
 * @param {{ secretKey: string, webhookSecret?: string | null, fetch?: typeof fetch, apiBase?: string, timeoutMs?: number }} options
 */
export function createStripe({
  secretKey,
  webhookSecret = null,
  fetch = globalThis.fetch,
  apiBase = STRIPE_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  async function call(method, path, { body, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${secretKey}` };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res;
    try {
      res = await fetch(`${apiBase}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`Stripe request failed: ${error?.message ?? 'network error'}`);
    }
    // Only the status is reported: Stripe's error messages can quote the key.
    if (!res.ok) throw new Error(`Stripe request failed with HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Stripe reply was not a JSON object');
    return data;
  }

  return {
    webhookConfigured: Boolean(webhookSecret),

    /**
     * A hosted Checkout page for one appeal. No case text goes to Stripe: the product is a fixed
     * string and the case is identified by id. The receipt description carries the appeal link.
     * @param {{ caseId: string, clickId: string, origin: string, now: Date }} order
     * @returns {Promise<{ id: string, url: string }>}
     */
    async createCheckout({ caseId, clickId, origin, now }) {
      const appealUrl = `${origin}/appeals/${clickId}`;
      const session = await call('POST', '/checkout/sessions', {
        idempotencyKey: `checkout-${clickId}`,
        body: formBody({
          mode: 'payment',
          client_reference_id: clickId,
          'metadata[case_id]': caseId,
          'line_items[0][quantity]': 1,
          'line_items[0][price_data][currency]': APPEAL_CURRENCY,
          'line_items[0][price_data][unit_amount]': APPEAL_PRICE_CENTS,
          'line_items[0][price_data][product_data][name]': APPEAL_PRODUCT,
          'line_items[0][price_data][product_data][description]':
            'New evidence, and the AI judge hears your case again. For fun, not legal advice.',
          success_url: appealUrl,
          cancel_url: `${origin}/cases/${caseId}`,
          expires_at: Math.floor(now.getTime() / 1000) + CHECKOUT_TTL_S,
          'payment_intent_data[description]': `Group Chat Court appeal. File or read your appeal at ${appealUrl}`,
          'custom_text[submit][message]': `One appeal for this case. Refunds on request within 14 days. Terms: ${origin}/terms`,
        }),
      });
      const url = typeof session.url === 'string' ? session.url : '';
      if (!SESSION_ID.test(session.id ?? '') || !url.startsWith(`${CHECKOUT_ORIGIN}/`)) {
        throw new Error('Stripe returned a session without a Checkout id or URL');
      }
      return { id: session.id, url };
    },

    /**
     * The session as fulfilment needs it. `paid` only for a completed $3.00 USD one-off payment.
     * @returns {Promise<{ id: string, clickId: string | null, caseId: string | null, paid: boolean }>}
     */
    async getSession(id) {
      if (!SESSION_ID.test(id ?? '')) throw new Error('Not a Checkout session id');
      const session = await call('GET', `/checkout/sessions/${id}`);
      if (session.id !== id) throw new Error('Stripe returned another session');
      return {
        id,
        clickId: CLICK_ID.test(session.client_reference_id ?? '') ? session.client_reference_id : null,
        caseId: typeof session.metadata?.case_id === 'string' ? session.metadata.case_id : null,
        paid:
          session.payment_status === 'paid' &&
          session.mode === 'payment' &&
          session.amount_total === APPEAL_PRICE_CENTS &&
          session.currency === APPEAL_CURRENCY,
      };
    },

    /**
     * Verifies a webhook delivery. `sessionId` is set only for the events that can complete a payment.
     * @param {string | Uint8Array} payload  the raw body
     * @returns {{ ok: false } | { ok: true, sessionId: string | null }}
     */
    readWebhook(payload, header, now) {
      if (!verifySignature(payload, header, webhookSecret, { nowMs: now.getTime() })) return { ok: false };
      let event;
      try {
        event = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'));
      } catch {
        return { ok: false };
      }
      const id = event?.data?.object?.id;
      const fulfils = FULFIL_EVENTS.includes(event?.type) && SESSION_ID.test(id ?? '');
      return { ok: true, sessionId: fulfils ? id : null };
    },
  };
}
