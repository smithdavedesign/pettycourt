// M4: Stripe Checkout for the $3 appeal, marking the case paid, and the appeal endpoint's payment gate.
// Stripe is the fake in ./stripe.js, which answers like test mode; nothing leaves the process.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPEAL_RULING, GOOD_RULING, HOUR, NEW_EVIDENCE, judgeReply, nearMiss, testDatabase } from './helpers.js';
import { CONTACT_EMAIL, OTHER_WEBHOOK_SECRET, paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
afterEach(() => vi.restoreAllMocks());

/** The judge rules a split, and overturns it to not guilty on appeal. */
const appealJudge = async (caseFile) => (caseFile.appeal ? judgeReply('not_guilty', APPEAL_RULING) : judgeReply());

const clicksFor = (caseId) =>
  db.sql(
    'SELECT id, checkout_session_id, paid_at, email FROM unlock_clicks WHERE case_id = $1 ORDER BY created_at, id',
    [caseId],
  );
const paidAtOf = async (caseId) => (await db.sql('SELECT paid_at FROM cases WHERE id = $1', [caseId]))[0]?.paid_at ?? null;
const appealOf = async (caseId) =>
  (
    await db.sql(
      `SELECT appeal_click_id, appeal_side, appeal_evidence, appealed_at, appeal_verdict, appeal_ruling, appeal_ruled_at,
              appeal_declined_at FROM cases WHERE id = $1`,
      [caseId],
    )
  )[0];

describe('M4 exit criterion: a test-mode checkout marks the case paid', () => {
  it('creates a $3 test-mode Checkout Session, and the signed checkout.session.completed webhook marks the case paid', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.ruledCase();

    const res = await t.checkout(filed.caseId);
    expect(res.status).toBe(200);
    const { caseId, clickId, url } = await res.json();
    expect(caseId).toBe(filed.caseId);
    expect(clickId).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // Stripe's test mode: a cs_test_ session for $3.00 USD, tied to this click and case.
    const [session] = t.stripe.created();
    expect(session.id).toMatch(/^cs_test_/);
    expect(session.livemode).toBe(false);
    expect(url).toBe(session.url);
    expect(url.startsWith('https://checkout.stripe.com/')).toBe(true);
    expect(session).toMatchObject({
      mode: 'payment',
      amount_total: 300,
      currency: 'usd',
      client_reference_id: clickId,
      metadata: { case_id: filed.caseId },
      success_url: `http://localhost/appeals/${clickId}`,
      cancel_url: `http://localhost/cases/${filed.caseId}`,
    });
    expect(await clicksFor(filed.caseId)).toEqual([
      { id: clickId, checkout_session_id: session.id, paid_at: null, email: null },
    ]);

    // Not paid yet: an open session is not a payment.
    expect(await paidAtOf(filed.caseId)).toBeNull();
    expect((await t.appeal(filed.caseId, clickId)).status).toBe(402);

    // The payer pays with a test card; Stripe delivers the signed event.
    t.advance(2 * 60 * 1000);
    t.stripe.pay(session.id);
    const hook = await t.deliver('checkout.session.completed', session.id);
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ received: true });

    expect((await paidAtOf(filed.caseId)).getTime()).toBe(t.clock.now.getTime());
    const [click] = await clicksFor(filed.caseId);
    expect(click.paid_at.getTime()).toBe(t.clock.now.getTime());
    expect((await db.store.getCase(filed.caseId)).paidAt.getTime()).toBe(t.clock.now.getTime());
  });

  it('the landing page Stripe sends the payer back to marks it paid too, without the webhook', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { clickId, session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);

    const page = await t.get(`/appeals/${clickId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/Paid \$3\.00/);
    expect(html).toContain(`data-api="/cases/${filed.caseId}/appeal"`);
    expect(await paidAtOf(filed.caseId)).not.toBeNull();
    expect((await clicksFor(filed.caseId))[0].paid_at).not.toBeNull();
  });

  it('webhook and landing page in either order, repeated or at once, record the payment once', async () => {
    const t = paidMode(db);
    for (const order of ['webhook-first', 'page-first', 'together']) {
      const filed = await t.ruledCase();
      const { clickId, session } = await t.startCheckout(filed.caseId);
      t.stripe.pay(session.id);
      const paidAt = new Date(t.clock.now);
      const hook = () => t.deliver('checkout.session.completed', session.id);
      const page = () => t.get(`/appeals/${clickId}`);
      if (order === 'webhook-first') {
        expect((await hook()).status).toBe(200);
        t.advance(1000);
        expect((await page()).status).toBe(200);
      } else if (order === 'page-first') {
        expect((await page()).status).toBe(200);
        t.advance(1000);
        expect((await hook()).status).toBe(200);
      } else {
        const results = await Promise.all([hook(), page(), hook(), page()]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      }
      t.advance(1000);
      expect((await hook()).status).toBe(200); // a redelivery
      expect((await paidAtOf(filed.caseId)).getTime(), order).toBe(paidAt.getTime());
      const clicks = await clicksFor(filed.caseId);
      expect(clicks, order).toHaveLength(1);
      expect(clicks[0].paid_at.getTime(), order).toBe(paidAt.getTime());
    }
  });
});

describe('M4 exit criterion: an appeal is accepted once and rejected (409) the second time', () => {
  it('the payer files one appeal (201, heard by the judge); a second one is 409 and the first stands', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    t.judge.mockClear();

    const first = await t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: NEW_EVIDENCE });
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body).toMatchObject({
      caseId: filed.caseId,
      caseUrl: `http://localhost/cases/${filed.caseId}`,
      heard: true,
      appeal: {
        side: 'defendant',
        evidence: NEW_EVIDENCE,
        verdict: 'not_guilty',
        ruling: APPEAL_RULING,
        outcome: 'overturned',
        declined: false,
      },
    });

    // The judge heard the original case, the original ruling and the new evidence.
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(t.judge.mock.calls[0][0]).toEqual({
      title: 'Said "five minutes away" while still in the shower',
      charge: 'Said "five minutes away" while still in the shower',
      plaintiffTestimony: 'I waited forty minutes outside the cinema and missed the trailers.',
      defendantTestimony: 'The shower was part of the journey. I was mentally en route.',
      defendantAppeared: true,
      appeal: { appellant: 'Defendant', newEvidence: NEW_EVIDENCE, originalVerdict: 'split', originalRuling: GOOD_RULING },
    });
    const stored = await appealOf(filed.caseId);
    expect(stored).toMatchObject({
      appeal_click_id: filed.clickId,
      appeal_side: 'defendant',
      appeal_evidence: NEW_EVIDENCE,
      appeal_verdict: 'not_guilty',
      appeal_ruling: APPEAL_RULING,
      appeal_declined_at: null,
    });

    t.advance(HOUR);
    const second = await t.appeal(filed.caseId, filed.clickId, { side: 'plaintiff', evidence: 'A better exhibit.' });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already been appealed/i);
    expect(await appealOf(filed.caseId)).toEqual(stored);
    expect(t.judge).toHaveBeenCalledTimes(1);

    // The original ruling is kept alongside the appeal.
    const found = await db.store.getCase(filed.caseId);
    expect(found).toMatchObject({ verdict: 'split', ruling: GOOD_RULING, appealVerdict: 'not_guilty' });
  });

  it('two appeals at the same moment: one 201, one 409, one stored', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const results = await Promise.all([
      t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: 'First exhibit.' }),
      t.appeal(filed.caseId, filed.clickId, { side: 'plaintiff', evidence: 'Second exhibit.' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const stored = await appealOf(filed.caseId);
    const winner = await results.find((r) => r.status === 201).json();
    expect(stored.appeal_evidence).toBe(winner.appeal.evidence);
  });
});

describe('M4 exit criterion: an unpaid case returns 402 on the appeal endpoint', () => {
  it('answers 402 for a ruled, unpaid case whatever credential comes with it, and stores nothing', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.ruledCase();
    const { clickId } = await t.startCheckout(filed.caseId); // started, never paid
    t.judge.mockClear();

    for (const token of [undefined, clickId, filed.plaintiffToken, filed.summonsToken]) {
      const res = await t.appeal(filed.caseId, token);
      expect(res.status, String(token)).toBe(402);
      expect((await res.json()).error).toMatch(/\$3/);
    }
    expect(t.judge).not.toHaveBeenCalled();
    expect(await appealOf(filed.caseId)).toMatchObject({ appealed_at: null, appeal_evidence: null });
  });

  it('is 402 with payments switched off too (the fake door can never pay)', async () => {
    const t = db.setup({ judge: appealJudge });
    const filed = await t.ruledCase();
    const res = await t.appeal(filed.caseId, filed.plaintiffToken);
    expect(res.status).toBe(402);
    expect(await appealOf(filed.caseId)).toMatchObject({ appealed_at: null });
  });
});

describe('POST /cases/:id/checkout', () => {
  it('sends Stripe the price, the receipt description with the appeal link, an expiry and an idempotency key', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase({ title: 'The Secret Shower Affair' });
    const { clickId, session } = await t.startCheckout(filed.caseId);
    const { params } = session;
    expect(params.get('line_items[0][quantity]')).toBe('1');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('300');
    expect(params.get('line_items[0][price_data][product_data][name]')).toMatch(/appeal/i);
    // Stripe prints this on the receipt email, so a payer who closed the tab can still find the appeal.
    expect(params.get('payment_intent_data[description]')).toContain(`http://localhost/appeals/${clickId}`);
    expect(params.get('custom_text[submit][message]')).toContain('http://localhost/terms');
    expect(Number(params.get('expires_at'))).toBe(t.nowSeconds() + 3600);

    const [, init] = t.stripe.fetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('idempotency-key')).toContain(clickId);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    // No case text goes to the payment processor.
    for (const text of ['Secret Shower', 'five minutes away', 'forty minutes', 'mentally en route']) {
      expect(init.body).not.toContain(encodeURIComponent(text).replace(/%20/g, '+'));
      expect(decodeURIComponent(init.body.replace(/\+/g, ' '))).not.toContain(text);
    }
  });

  it('uses the public origin for the URLs it gives Stripe when one is configured', async () => {
    const t = paidMode(db, { publicOrigin: 'https://pettycourt.onrender.com' });
    const filed = await t.ruledCase();
    const { clickId, session } = await t.startCheckout(filed.caseId);
    expect(session.success_url).toBe(`https://pettycourt.onrender.com/appeals/${clickId}`);
    expect(session.cancel_url).toBe(`https://pettycourt.onrender.com/cases/${filed.caseId}`);
  });

  it('is 503 with payments switched off, and the case page keeps the M3 fake door', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const res = await t.checkout(filed.caseId);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/payments/i);
    expect(await clicksFor(filed.caseId)).toHaveLength(0);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain(`data-api="/cases/${filed.caseId}/unlock"`);
    expect(page).not.toContain('/checkout');
  });

  it('refuses a case with nothing to appeal yet, or that is closed, paid or appealed (409), and stores no click', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const waiting = await t.fileCase();
    const answered = await t.fileCase();
    await t.answer(answered.summonsToken);
    const reported = await t.ruledCase();
    await t.report(reported.caseId);
    const paid = await t.paidCase();
    const appealed = await t.paidCase();
    expect((await t.appeal(appealed.caseId, appealed.clickId)).status).toBe(201);

    const declining = paidMode(db, { judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const declined = await declining.fileCase();
    await declining.answer(declined.summonsToken);
    await declining.post(`/cases/${declined.caseId}/rule`);

    for (const [name, filed, pattern] of [
      ['waiting for the defendant', waiting, /after the ruling/i],
      ['answered, not ruled', answered, /after the ruling/i],
      ['taken down', reported, /taken down/i],
      ['already paid', paid, /already paid/i],
      ['already appealed', appealed, /already/i],
      ['declined', declined, /declined/i],
    ]) {
      const before = (await clicksFor(filed.caseId)).length;
      const res = await (name === 'declined' ? declining : t).checkout(filed.caseId);
      expect(res.status, name).toBe(409);
      expect((await res.json()).error, name).toMatch(pattern);
      expect((await clicksFor(filed.caseId)).length, name).toBe(before);
    }
    expect(t.stripe.created()).toHaveLength(2); // only the two paid cases reached Stripe
  });

  it('is 404 for a missing or malformed case and 415 without JSON', async () => {
    const t = paidMode(db);
    expect((await t.checkout('x'.repeat(16))).status).toBe(404);
    expect((await t.checkout('nope')).status).toBe(404);
    const filed = await t.ruledCase();
    const res = await t.request(`/cases/${filed.caseId}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(415);
    expect(t.stripe.fetch).not.toHaveBeenCalled();
  });

  it('answers 502 when Stripe fails or is unreachable, keeps the click, and never logs the key', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const failure of [500, 'network', 401]) {
      t.stripe.failNext(failure);
      const res = await t.checkout(filed.caseId);
      expect(res.status, String(failure)).toBe(502);
      expect((await res.json()).error).toMatch(/try again/i);
    }
    const clicks = await clicksFor(filed.caseId);
    expect(clicks).toHaveLength(3);
    expect(clicks.every((c) => c.checkout_session_id === null)).toBe(true);
    const logged = errors.mock.calls.flat().map(String).join(' ');
    expect(logged).toMatch(/Stripe/);
    expect(logged).not.toMatch(/sk_test_/);
  });

  it('refuses to send the browser anywhere but Stripe Checkout (502)', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = t.stripe.fetch.getMockImplementation();
    t.stripe.fetch.mockImplementationOnce(async (url, init) => {
      const res = await real(url, init);
      const session = await res.json();
      return new Response(JSON.stringify({ ...session, url: 'https://evil.example/pay' }), { status: 200 });
    });
    const res = await t.checkout(filed.caseId);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('evil.example');
  });
});

describe('fulfilment', () => {
  it('does not mark an unpaid, wrong-amount or wrong-currency session as paid', async () => {
    const t = paidMode(db);
    for (const changes of [{ payment_status: 'unpaid', status: 'complete' }, { amount_total: 100 }, { currency: 'eur' }, { mode: 'subscription' }]) {
      const filed = await t.ruledCase();
      const { clickId, session } = await t.startCheckout(filed.caseId);
      t.stripe.pay(session.id, changes);
      expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(200);
      expect((await t.get(`/appeals/${clickId}`)).status).toBe(200);
      expect(await paidAtOf(filed.caseId), JSON.stringify(changes)).toBeNull();
      expect((await clicksFor(filed.caseId))[0].paid_at).toBeNull();
    }
  });

  it('an unpaid landing page says the payment has not gone through and offers no appeal form', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { clickId } = await t.startCheckout(filed.caseId);
    const page = await (await t.get(`/appeals/${clickId}`)).text();
    expect(page).toMatch(/haven't received/i);
    expect(page).not.toContain('name="evidence"');
    expect(page).toContain(`href="/cases/${filed.caseId}"`);
  });

  it('a payment for a case deleted before fulfilment is acknowledged (so Stripe stops retrying) and logged for a refund', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    expect((await t.deleteCase(filed.caseId, filed.plaintiffToken)).status).toBe(200);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await t.deliver('checkout.session.completed', session.id);
    expect(res.status).toBe(200);
    expect(errors.mock.calls.flat().join(' ')).toMatch(new RegExp(`refund.*${session.id}`, 'i'));
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
  });

  it('a second payer on the same case is recorded on their own click; the first payment stands; their page offers a refund', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.ruledCase();
    // Two people open Checkout before either has paid.
    const first = await t.startCheckout(filed.caseId);
    const second = await t.startCheckout(filed.caseId);
    t.stripe.pay(first.session.id);
    await t.deliver('checkout.session.completed', first.session.id);
    const paidAt = await paidAtOf(filed.caseId);
    // The first payment raises no alarm; the second is logged for a refund.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errors).not.toHaveBeenCalled();
    t.advance(60_000);
    t.stripe.pay(second.session.id);
    await t.deliver('checkout.session.completed', second.session.id);
    expect(errors.mock.calls.flat().join(' ')).toMatch(new RegExp(`second payment.*${second.session.id}.*refund`, 'i'));

    expect((await paidAtOf(filed.caseId)).getTime()).toBe(paidAt.getTime());
    const clicks = await clicksFor(filed.caseId);
    expect(clicks.filter((c) => c.paid_at)).toHaveLength(2);

    expect((await t.appeal(filed.caseId, first.clickId)).status).toBe(201);
    const late = await t.appeal(filed.caseId, second.clickId);
    expect(late.status).toBe(409);
    const page = await (await t.get(`/appeals/${second.clickId}`)).text();
    expect(page).toMatch(/refund/i);
    expect(page).toContain(CONTACT_EMAIL);
    expect(page).not.toContain('name="evidence"');
  });

  it('finds the click through client_reference_id when storing the session id had failed', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { clickId, session } = await t.startCheckout(filed.caseId);
    // As if storing the session id had failed after Stripe created it.
    await db.sql('UPDATE unlock_clicks SET checkout_session_id = NULL WHERE id = $1', [clickId]);
    t.stripe.pay(session.id);
    expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(200);
    const [click] = await clicksFor(filed.caseId);
    expect(click).toMatchObject({ checkout_session_id: session.id });
    expect(click.paid_at).not.toBeNull();
  });
});

describe('POST /stripe/webhook', () => {
  it('rejects a missing, malformed, tampered, stale or wrongly signed delivery with 400 and marks nothing', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    const good = t.stripe.event('checkout.session.completed', session.id, { atSeconds: t.nowSeconds() });

    const cases = [
      ['no signature', { body: good.body }],
      ['empty signature', { body: good.body, signature: '' }],
      ['garbage', { body: good.body, signature: 'nonsense' }],
      ['no v1', { body: good.body, signature: good.signature.replace('v1=', 'v0=') }],
      ['tampered body', { body: good.body.replace('"livemode":false', '"livemode":true'), signature: good.signature }],
      ['other secret', t.stripe.event('checkout.session.completed', session.id, { atSeconds: t.nowSeconds(), secret: OTHER_WEBHOOK_SECRET })],
      ['301 s old', t.stripe.event('checkout.session.completed', session.id, { atSeconds: t.nowSeconds() - 301 })],
      ['301 s ahead', t.stripe.event('checkout.session.completed', session.id, { atSeconds: t.nowSeconds() + 301 })],
    ];
    for (const [name, delivery] of cases) {
      const res = await t.webhook(delivery);
      expect(res.status, name).toBe(400);
    }
    expect(await paidAtOf(filed.caseId)).toBeNull();
    // Stripe was only asked to create the session, never to read it back for a bad delivery.
    expect(t.stripe.fetch).toHaveBeenCalledTimes(1);

    // 300 s is still inside the tolerance.
    const edge = await t.webhook(t.stripe.event('checkout.session.completed', session.id, { atSeconds: t.nowSeconds() - 300 }));
    expect(edge.status).toBe(200);
    expect(await paidAtOf(filed.caseId)).not.toBeNull();
  });

  it('acknowledges other event types without asking Stripe anything', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.fetch.mockClear();
    for (const type of ['checkout.session.expired', 'payment_intent.succeeded', 'charge.refunded']) {
      const res = await t.deliver(type, session.id);
      expect(res.status, type).toBe(200);
    }
    expect(t.stripe.fetch).not.toHaveBeenCalled();
  });

  it('fulfils checkout.session.async_payment_succeeded as well', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    expect((await t.deliver('checkout.session.async_payment_succeeded', session.id)).status).toBe(200);
    expect(await paidAtOf(filed.caseId)).not.toBeNull();
  });

  it('answers 502 when Stripe cannot be reached to re-read the session, so Stripe retries', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.stripe.failNext(503);
    expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(502);
    expect(await paidAtOf(filed.caseId)).toBeNull();
    expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(200);
    expect(await paidAtOf(filed.caseId)).not.toBeNull();
  });

  it('is 503 when no webhook secret is configured, and 404 with payments off', async () => {
    const t = paidMode(db, { webhookSecret: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(503);
    expect(await paidAtOf(filed.caseId)).toBeNull();

    const off = db.setup();
    expect((await off.webhook({ body: '{}', signature: 't=1,v1=00' })).status).toBe(404);
  });

  it('accepts an event body larger than the 16 KB API limit', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id, { padding: 'x'.repeat(20 * 1024) });
    expect((await t.deliver('checkout.session.completed', session.id)).status).toBe(200);
    expect(await paidAtOf(filed.caseId)).not.toBeNull();
  });
});

describe('the appellant page', () => {
  it('is 404 for a wrong or malformed click id, and for a fake-door click', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const { clickId } = await t.startCheckout(filed.caseId);
    for (const path of [`/appeals/${nearMiss(clickId)}`, '/appeals/short', `/appeals/${filed.plaintiffToken}`]) {
      const res = await t.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain('five minutes away');
    }
    const fake = db.setup();
    const other = await fake.fileCase();
    const { clickId: fakeClick } = await (await fake.unlock(other.caseId)).json();
    expect((await t.get(`/appeals/${fakeClick}`)).status).toBe(404);
  });

  it('shows the receipt line and the appeal form after paying, then the outcome after the appeal', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    let page = await (await t.get(`/appeals/${filed.clickId}`)).text();
    expect(page).toMatch(/Paid \$3\.00 on 2026-11-01/);
    expect(page).toMatch(/receipt/i);
    expect(page).toContain(`data-token="${filed.clickId}"`);
    expect(page).toContain('name="side"');
    expect(page).toContain('value="plaintiff"');
    expect(page).toContain('value="defendant"');
    expect(page).toContain('name="evidence"');
    expect(page).toContain('maxlength="1000"');
    expect(page).toMatch(/Verdict: Split decision/);
    // The page never shows the parties' private links.
    for (const token of [filed.plaintiffToken, filed.summonsToken, filed.juryToken]) expect(page).not.toContain(token);

    await t.appeal(filed.caseId, filed.clickId);
    page = await (await t.get(`/appeals/${filed.clickId}`)).text();
    expect(page).not.toContain('name="evidence"');
    expect(page).toMatch(/Verdict on appeal: Not guilty/);
    expect(page).toMatch(/overturned/i);
  });

  it('a taken-down case answers 410 with none of its content, and tells the payer they are owed a refund', async () => {
    const t = paidMode(db);
    const filed = await t.paidCase();
    await t.report(filed.caseId);
    const res = await t.get(`/appeals/${filed.clickId}`);
    expect(res.status).toBe(410);
    const page = await res.text();
    expect(page).not.toContain('five minutes away');
    expect(page).toMatch(/owed a refund/i);
    expect(page).toContain(`mailto:${CONTACT_EMAIL}`);
    // Everyone else's view of a taken-down case says nothing about money.
    expect(await (await t.get(`/cases/${filed.caseId}`)).text()).not.toMatch(/refund/i);
  });
});
