// A fake Stripe for tests: a `fetch` that answers the two Checkout Session endpoints the app uses the
// way Stripe's test mode does (cs_test_… ids, livemode: false, idempotency keys), plus what Stripe does
// outside our process: the payer paying with a test card, and signed webhook deliveries. Nothing here
// reaches the network, and the key and webhook secret are assembled at runtime (they're fakes).
import { createHmac, randomBytes } from 'node:crypto';
import { expect, vi } from 'vitest';
import { STRIPE_API_BASE, createStripe } from '../src/payments.js';

export const FAKE_STRIPE_KEY = ['sk', 'test', 'A1b2C3d4'.repeat(6)].join('_');
export const FAKE_WEBHOOK_SECRET = ['whsec', 'A1b2C3d4'.repeat(4)].join('_');
export const OTHER_WEBHOOK_SECRET = ['whsec', 'Z9y8X7w6'.repeat(4)].join('_');
export const CONTACT_EMAIL = 'court@example.com';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stripeError = (status, message) => json(status, { error: { type: 'invalid_request_error', message } });

/**
 * A test app with payments switched on against a fake Stripe (`db` is a `testDatabase()`), plus the
 * M4 flows: start a checkout, pay it, deliver the webhook.
 * @param {ReturnType<typeof import('./helpers.js').testDatabase>} db
 */
export function paidMode(db, { webhookSecret = FAKE_WEBHOOK_SECRET, ...setupOptions } = {}) {
  const stripe = fakeStripe();
  const payments = createStripe({ secretKey: FAKE_STRIPE_KEY, webhookSecret, fetch: stripe.fetch });
  const t = db.setup({ payments, contactEmail: CONTACT_EMAIL, ...setupOptions });

  /** POST /cases/:id/checkout, expecting 200; returns the reply and the session Stripe created. */
  async function startCheckout(caseId) {
    const res = await t.checkout(caseId);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    return { ...body, session: stripe.created().at(-1) };
  }

  /** Stripe delivers a signed event for the session, stamped with the app's clock. */
  const deliver = (type, sessionId, options = {}) =>
    t.webhook(stripe.event(type, sessionId, { atSeconds: t.nowSeconds(), ...options }));

  /** A ruled case whose appeal is paid for: checkout, test-card payment, webhook. */
  async function paidCase(fields) {
    const filed = await t.ruledCase(fields);
    const { clickId, session } = await startCheckout(filed.caseId);
    stripe.pay(session.id);
    const res = await deliver('checkout.session.completed', session.id);
    expect(res.status).toBe(200);
    return { ...filed, clickId, session };
  }

  return { ...t, stripe, payments, startCheckout, deliver, paidCase };
}

/** The `Stripe-Signature` header Stripe would send for `payload` at `atSeconds`. */
export function signPayload(payload, { secret = FAKE_WEBHOOK_SECRET, atSeconds }) {
  const signature = createHmac('sha256', secret).update(`${atSeconds}.${payload}`).digest('hex');
  return `t=${atSeconds},v1=${signature}`;
}

/**
 * @param {{ secretKey?: string }} [options]
 */
export function fakeStripe({ secretKey = FAKE_STRIPE_KEY } = {}) {
  /** Sessions by id, with the raw form params the app sent kept under `params`. */
  const sessions = new Map();
  const byIdempotencyKey = new Map();
  let failures = [];

  const publicView = ({ params, ...session }) => session;

  const fetch = vi.fn(async (url, init = {}) => {
    const failure = failures.shift();
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure) return stripeError(failure, 'Something went wrong on our end.');

    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== `Bearer ${secretKey}`) return stripeError(401, 'Invalid API Key provided.');
    const { pathname } = new URL(url);
    const base = new URL(STRIPE_API_BASE).pathname;
    const method = init.method ?? 'GET';

    if (method === 'POST' && pathname === `${base}/checkout/sessions`) {
      const key = headers.get('idempotency-key');
      if (key && byIdempotencyKey.has(key)) return json(200, publicView(sessions.get(byIdempotencyKey.get(key))));
      const params = new URLSearchParams(init.body);
      const id = `cs_test_${randomBytes(24).toString('hex')}`;
      const session = {
        id,
        object: 'checkout.session',
        livemode: false,
        mode: params.get('mode'),
        status: 'open',
        payment_status: 'unpaid',
        amount_total:
          Number(params.get('line_items[0][price_data][unit_amount]')) * Number(params.get('line_items[0][quantity]')),
        currency: params.get('line_items[0][price_data][currency]'),
        client_reference_id: params.get('client_reference_id'),
        metadata: { case_id: params.get('metadata[case_id]') },
        success_url: params.get('success_url'),
        cancel_url: params.get('cancel_url'),
        expires_at: Number(params.get('expires_at')),
        url: `https://checkout.stripe.com/c/pay/${id}`,
        params,
      };
      sessions.set(id, session);
      if (key) byIdempotencyKey.set(key, id);
      return json(200, publicView(session));
    }

    const match = /\/checkout\/sessions\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && match) {
      const session = sessions.get(decodeURIComponent(match[1]));
      return session ? json(200, publicView(session)) : stripeError(404, 'No such checkout.session');
    }
    return stripeError(404, `Unrecognized request URL (${method}: ${pathname})`);
  });

  return {
    fetch,
    sessions,
    /** Every session the app created, oldest first. */
    created: () => [...sessions.values()],
    /** The payer completes Checkout with a test card. */
    pay(id, changes = {}) {
      const session = sessions.get(id);
      if (!session) throw new Error(`fake Stripe: no session ${id}`);
      Object.assign(session, { status: 'complete', payment_status: 'paid', ...changes });
      return session;
    },
    /** The next calls fail: an HTTP status (e.g. 500) or 'network'. */
    failNext(...kinds) {
      failures = kinds;
    },
    /** A webhook delivery for `id`: the raw JSON body and its Stripe-Signature header. */
    event(type, id, { atSeconds, secret = FAKE_WEBHOOK_SECRET } = {}) {
      const session = sessions.get(id);
      const body = JSON.stringify({
        id: `evt_${randomBytes(12).toString('hex')}`,
        object: 'event',
        type,
        livemode: false,
        created: atSeconds,
        data: { object: session ? publicView(session) : { id, object: 'checkout.session' } },
      });
      return { body, signature: signPayload(body, { secret, atSeconds }) };
    },
  };
}
