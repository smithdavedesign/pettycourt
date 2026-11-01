// The Stripe client in src/payments.js on its own: the requests it sends, what it accepts back, and the
// webhook signature check. The key and webhook secret are fakes assembled at runtime (./stripe.js).
import { describe, expect, it, vi } from 'vitest';
import {
  APPEAL_PRICE_CENTS,
  CHECKOUT_TTL_S,
  FULFIL_EVENTS,
  STRIPE_API_BASE,
  WEBHOOK_TOLERANCE_S,
  createStripe,
  verifySignature,
} from '../src/payments.js';
import { FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, OTHER_WEBHOOK_SECRET, fakeStripe, signPayload } from './stripe.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const CHECKOUT = { caseId: 'caseAAAAAAAAAAAA', clickId: 'c'.repeat(32), origin: 'https://court.example', now: NOW };
const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('createCheckout', () => {
  it('POSTs a form-encoded Checkout Session to the Stripe API with the key, an idempotency key and a timeout', async () => {
    const stripe = fakeStripe();
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch: stripe.fetch });
    const session = await client.createCheckout(CHECKOUT);

    expect(stripe.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = stripe.fetch.mock.calls[0];
    expect(STRIPE_API_BASE).toBe('https://api.stripe.com/v1');
    expect(url).toBe(`${STRIPE_API_BASE}/checkout/sessions`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${FAKE_STRIPE_KEY}`);
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['idempotency-key']).toBe(`checkout-${CHECKOUT.clickId}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const params = Object.fromEntries(new URLSearchParams(init.body));
    expect(params).toMatchObject({
      mode: 'payment',
      client_reference_id: CHECKOUT.clickId,
      'metadata[case_id]': CHECKOUT.caseId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(APPEAL_PRICE_CENTS),
      success_url: `https://court.example/appeals/${CHECKOUT.clickId}`,
      cancel_url: `https://court.example/cases/${CHECKOUT.caseId}`,
      expires_at: String(NOW_S + CHECKOUT_TTL_S),
    });
    expect(APPEAL_PRICE_CENTS).toBe(300);
    expect(CHECKOUT_TTL_S).toBeGreaterThanOrEqual(30 * 60); // Stripe's minimum
    expect(params['payment_intent_data[description]']).toContain(`https://court.example/appeals/${CHECKOUT.clickId}`);
    expect(params['custom_text[submit][message]']).toContain('https://court.example/terms');
    expect(params['custom_text[submit][message]'].length).toBeLessThanOrEqual(1200);

    expect(session.id).toMatch(/^cs_test_/);
    expect(session.url).toBe(`https://checkout.stripe.com/c/pay/${session.id}`);
  });

  it('throws with the HTTP status only, never the key or Stripe’s message', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${FAKE_STRIPE_KEY}` } }), { status: 401 }));
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch });
    const error = await client.createCheckout(CHECKOUT).catch((e) => e);
    expect(error.message).toBe('Stripe request failed with HTTP 401');
    expect(error.message).not.toContain(FAKE_STRIPE_KEY);
  });

  it('wraps a network failure without the key', async () => {
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch: async () => { throw new TypeError('fetch failed'); } });
    const error = await client.createCheckout(CHECKOUT).catch((e) => e);
    expect(error.message).toMatch(/^Stripe request failed: fetch failed/);
  });

  it.each([
    ['a non-Stripe URL', { id: 'cs_test_abc123', url: 'https://evil.example/pay' }],
    ['an http URL', { id: 'cs_test_abc123', url: 'http://checkout.stripe.com/c/pay/cs_test_abc123' }],
    ['a look-alike host', { id: 'cs_test_abc123', url: 'https://checkout.stripe.com.evil.example/c' }],
    ['no URL', { id: 'cs_test_abc123' }],
    ['a malformed id', { id: 'pi_123', url: 'https://checkout.stripe.com/c/pay/x' }],
    ['no id', { url: 'https://checkout.stripe.com/c/pay/x' }],
  ])('rejects a reply with %s', async (_name, reply) => {
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch: async () => okJson(reply) });
    await expect(client.createCheckout(CHECKOUT)).rejects.toThrow(/Stripe/);
  });
});

describe('getSession', () => {
  const session = (changes = {}) => ({
    id: 'cs_test_abc123',
    object: 'checkout.session',
    livemode: false,
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 300,
    currency: 'usd',
    client_reference_id: 'c'.repeat(32),
    metadata: { case_id: CHECKOUT.caseId },
    ...changes,
  });

  it('GETs the session by id and reports it paid only for $3.00 USD in payment mode', async () => {
    const fetch = vi.fn(async () => okJson(session()));
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch });
    expect(await client.getSession('cs_test_abc123')).toEqual({
      id: 'cs_test_abc123',
      clickId: 'c'.repeat(32),
      caseId: CHECKOUT.caseId,
      paid: true,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${STRIPE_API_BASE}/checkout/sessions/cs_test_abc123`);
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe(`Bearer ${FAKE_STRIPE_KEY}`);
  });

  it.each([
    ['unpaid', { payment_status: 'unpaid' }],
    ['no payment required', { payment_status: 'no_payment_required' }],
    ['another amount', { amount_total: 299 }],
    ['another currency', { currency: 'eur' }],
    ['subscription mode', { mode: 'subscription' }],
  ])('is not paid when %s', async (_name, changes) => {
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch: async () => okJson(session(changes)) });
    expect((await client.getSession('cs_test_abc123')).paid).toBe(false);
  });

  it('gives a null clickId for a session that was not ours, and refuses a malformed id without calling Stripe', async () => {
    const fetch = vi.fn(async () => okJson(session({ client_reference_id: null })));
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, fetch });
    expect((await client.getSession('cs_test_abc123')).clickId).toBeNull();
    fetch.mockClear();
    await expect(client.getSession('../../v1/charges')).rejects.toThrow(/session id/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('verifySignature', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const nowMs = NOW.getTime();
  const sign = (options = {}) => signPayload(payload, { atSeconds: NOW_S, ...options });

  it('accepts a valid signature, as a string or raw bytes', () => {
    expect(verifySignature(payload, sign(), FAKE_WEBHOOK_SECRET, { nowMs })).toBe(true);
    expect(verifySignature(new TextEncoder().encode(payload), sign(), FAKE_WEBHOOK_SECRET, { nowMs })).toBe(true);
  });

  it('accepts any matching v1 during a secret rotation, and ignores v0', () => {
    const other = sign({ secret: OTHER_WEBHOOK_SECRET });
    const good = sign();
    const rotated = `t=${NOW_S},v1=${other.split('v1=')[1]},v1=${good.split('v1=')[1]},v0=deadbeef`;
    expect(verifySignature(payload, rotated, FAKE_WEBHOOK_SECRET, { nowMs })).toBe(true);
    expect(verifySignature(payload, `t=${NOW_S},v0=${good.split('v1=')[1]}`, FAKE_WEBHOOK_SECRET, { nowMs })).toBe(false);
  });

  it('rejects a tampered payload, another secret, and malformed headers', () => {
    expect(verifySignature(`${payload} `, sign(), FAKE_WEBHOOK_SECRET, { nowMs })).toBe(false);
    expect(verifySignature(payload, sign({ secret: OTHER_WEBHOOK_SECRET }), FAKE_WEBHOOK_SECRET, { nowMs })).toBe(false);
    for (const header of [undefined, null, '', 'v1=abc', 't=abc,v1=00', `t=${NOW_S}`, `t=${NOW_S},v1=zz`, `t=${NOW_S},v1=`]) {
      expect(verifySignature(payload, header, FAKE_WEBHOOK_SECRET, { nowMs }), String(header)).toBe(false);
    }
    expect(verifySignature(payload, sign(), '', { nowMs })).toBe(false);
  });

  it(`allows ${WEBHOOK_TOLERANCE_S} s of clock difference either way, and no more`, () => {
    expect(WEBHOOK_TOLERANCE_S).toBe(300);
    for (const offset of [-300, 300]) {
      expect(verifySignature(payload, sign({ atSeconds: NOW_S + offset }), FAKE_WEBHOOK_SECRET, { nowMs }), String(offset)).toBe(true);
    }
    for (const offset of [-301, 301]) {
      expect(verifySignature(payload, sign({ atSeconds: NOW_S + offset }), FAKE_WEBHOOK_SECRET, { nowMs }), String(offset)).toBe(false);
    }
  });
});

describe('readWebhook', () => {
  it('returns the session id for the fulfilling event types only, and fails on a bad signature', () => {
    expect(FULFIL_EVENTS).toEqual(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
    const client = createStripe({ secretKey: FAKE_STRIPE_KEY, webhookSecret: FAKE_WEBHOOK_SECRET, fetch: vi.fn() });
    const event = (type, object = { id: 'cs_test_abc123' }) => JSON.stringify({ id: 'evt_1', type, data: { object } });
    const read = (body, header = signPayload(body, { atSeconds: NOW_S })) => client.readWebhook(body, header, NOW);

    for (const type of FULFIL_EVENTS) expect(read(event(type))).toEqual({ ok: true, sessionId: 'cs_test_abc123' });
    expect(read(event('checkout.session.expired'))).toEqual({ ok: true, sessionId: null });
    expect(read(event('checkout.session.completed', { id: 'not-a-session' }))).toEqual({ ok: true, sessionId: null });
    expect(read(event('checkout.session.completed'), 't=1,v1=00')).toEqual({ ok: false });
    expect(read('not json')).toEqual({ ok: false });
    expect(client.webhookConfigured).toBe(true);
    expect(createStripe({ secretKey: FAKE_STRIPE_KEY, fetch: vi.fn() }).webhookConfigured).toBe(false);
  });
});
