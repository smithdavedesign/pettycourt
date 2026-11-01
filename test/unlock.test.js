import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOUR, nearMiss, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
afterEach(() => vi.restoreAllMocks());

const clicksFor = (caseId) =>
  db.sql('SELECT id, case_id, email, created_at, email_at FROM unlock_clicks WHERE case_id = $1 ORDER BY created_at, id', [
    caseId,
  ]);

describe('M3 exit criterion: a click on the unlock button stores one row and returns 200 with no payment call', () => {
  it('stores one row with the case id, returns 200 with charged: false, and makes no outbound call', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    t.judge.mockClear();
    // Any payment provider would be reached over the network; nothing may leave the process.
    const outbound = vi.spyOn(globalThis, 'fetch');

    const res = await t.unlock(filed.caseId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ caseId: filed.caseId, charged: false });
    expect(body.clickId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.message).toMatch(/nothing was charged/i);

    const rows = await clicksFor(filed.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.clickId, case_id: filed.caseId, email: null, email_at: null });
    expect(rows[0].created_at.getTime()).toBe(t.clock.now.getTime());

    expect(outbound).not.toHaveBeenCalled();
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('works before the ruling too, and each click is its own row', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.unlock(filed.caseId)).status).toBe(200);
    t.advance(HOUR);
    expect((await t.unlock(filed.caseId)).status).toBe(200);
    const rows = await clicksFor(filed.caseId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  // M4 changed this test, on purpose: in M3 it scanned every file in src/, which encoded M3's "no payment
  // code at all" scope. M4's roadmap adds Stripe Checkout, which lives in src/payments.js alone and is
  // only reached through the injected `payments` dependency. The next test proves the M3 criterion with
  // payments switched on.
  it('the unlock click has no payment client to call: no payment SDK, and only src/payments.js knows a provider', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ')).not.toMatch(/stripe|paddle|lemon|braintree/i);
    const src = new URL('../src/', import.meta.url);
    for (const file of readdirSync(src)) {
      if (file === 'payments.js') continue;
      expect(readFileSync(new URL(file, src), 'utf8'), file).not.toMatch(/api\.stripe\.com|checkout\.session/i);
    }
  });

  it('with payments switched on (M4), the unlock click still stores one row and calls neither Stripe nor fetch', async () => {
    const { paidMode } = await import('./stripe.js');
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const outbound = vi.spyOn(globalThis, 'fetch');
    const res = await t.unlock(filed.caseId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ caseId: filed.caseId, charged: false });
    expect(await clicksFor(filed.caseId)).toHaveLength(1);
    expect(t.stripe.fetch).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe('the email step', () => {
  it('stores the email on the same row, once per click', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const { clickId } = await (await t.unlock(filed.caseId)).json();
    t.advance(60_000);
    const res = await t.unlockEmail(filed.caseId, { clickId, email: '  Plaintiff@Example.com ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caseId: filed.caseId, saved: true });
    const rows = await clicksFor(filed.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('Plaintiff@Example.com');
    expect(rows[0].email_at.getTime()).toBe(t.clock.now.getTime());

    // A typo fix replaces it; still one row.
    expect((await t.unlockEmail(filed.caseId, { clickId, email: 'plaintiff@example.org' })).status).toBe(200);
    expect((await clicksFor(filed.caseId)).map((r) => r.email)).toEqual(['plaintiff@example.org']);
  });

  it.each([
    ['missing email', {}],
    ['blank email', { email: '   ' }],
    ['no @', { email: 'plaintiff.example.com' }],
    ['no domain dot', { email: 'plaintiff@localhost' }],
    ['spaces inside', { email: 'plain tiff@example.com' }],
    ['two @', { email: 'a@b@example.com' }],
    ['not a string', { email: ['a@example.com'] }],
    ['over 254 characters', { email: `${'a'.repeat(250)}@example.com` }],
  ])('rejects %s with 400 and stores nothing', async (_name, fields) => {
    const t = db.setup();
    const filed = await t.fileCase();
    const { clickId } = await (await t.unlock(filed.caseId)).json();
    const res = await t.unlockEmail(filed.caseId, { clickId, ...fields });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
    expect((await clicksFor(filed.caseId))[0].email).toBeNull();
  });

  it('rejects a malformed click id with 400, and an unknown or foreign one with 404', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const other = await t.fileCase({ title: 'Another case' });
    const { clickId } = await (await t.unlock(filed.caseId)).json();
    const { clickId: otherClick } = await (await t.unlock(other.caseId)).json();
    const email = 'someone@example.com';

    for (const bad of [undefined, 42, 'short']) {
      expect((await t.unlockEmail(filed.caseId, { clickId: bad, email })).status, String(bad)).toBe(400);
    }
    expect((await t.unlockEmail(filed.caseId, { clickId: nearMiss(clickId), email })).status).toBe(404);
    // A click from another case can't be used on this one.
    expect((await t.unlockEmail(filed.caseId, { clickId: otherClick, email })).status).toBe(404);
    expect((await t.unlockEmail('x'.repeat(16), { clickId, email })).status).toBe(404);
    expect((await t.unlockEmail('bad', { clickId, email })).status).toBe(404);
    expect((await clicksFor(filed.caseId))[0].email).toBeNull();
    expect((await clicksFor(other.caseId))[0].email).toBeNull();
  });

  it('never logs the email', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const { clickId } = await (await t.unlock(filed.caseId)).json();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await t.unlockEmail(filed.caseId, { clickId, email: 'private@example.com' });
    await t.unlockEmail(filed.caseId, { clickId, email: 'not-an-email' });
    expect([...spy.mock.calls, ...log.mock.calls].flat().join(' ')).not.toContain('private@example.com');
  });
});

describe('which cases can be unlocked', () => {
  it('a missing or malformed case is 404 and stores nothing', async () => {
    const t = db.setup();
    expect((await t.unlock('x'.repeat(16))).status).toBe(404);
    expect((await t.unlock('nope')).status).toBe(404);
    expect((await db.sql("SELECT count(*)::int AS n FROM unlock_clicks WHERE case_id = 'xxxxxxxxxxxxxxxx'"))[0].n).toBe(0);
  });

  it('a declined case is 409 and stores nothing', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const res = await t.unlock(filed.caseId);
    expect(res.status).toBe(409);
    expect(await clicksFor(filed.caseId)).toHaveLength(0);
  });

  it('a taken-down case is 409 and stores nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    await t.report(filed.caseId);
    expect((await t.unlock(filed.caseId)).status).toBe(409);
    expect(await clicksFor(filed.caseId)).toHaveLength(0);
  });

  it('needs a JSON request, so a cross-site form can not add clicks', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.request(`/cases/${filed.caseId}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(415);
    expect(await clicksFor(filed.caseId)).toHaveLength(0);
  });
});

describe('the unlock button on the case page', () => {
  it('appears while waiting, when ready and after the ruling, with the email step hidden', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const pages = [await (await t.get(`/cases/${filed.caseId}`)).text()];
    await t.answer(filed.summonsToken);
    pages.push(await (await t.get(`/cases/${filed.caseId}`)).text());
    await t.post(`/cases/${filed.caseId}/rule`);
    pages.push(await (await t.get(`/cases/${filed.caseId}`)).text());
    for (const page of pages) {
      expect(page).toMatch(/Full trial · \$3/);
      expect(page).toContain(`data-api="/cases/${filed.caseId}/unlock"`);
      expect(page).toContain(`data-api="/cases/${filed.caseId}/unlock/email"`);
      expect(page).toMatch(/<div id="unlock-email" hidden>/);
      expect(page).toContain('name="clickId"');
      expect(page).toContain('type="email"');
    }
  });

  it('is not offered on a declined case', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('/unlock');
    expect(page).not.toMatch(/Full trial/);
  });

  it('says how the email is used and when it is deleted, where it is collected', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/nothing was charged/i);
    expect(page).toMatch(/deleted with (this|the) case/i);
  });
});
