// M4: the terms and privacy pages that taking money needs, and the links to them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from './helpers.js';
import { CONTACT_EMAIL, paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

describe('/terms', () => {
  it('says what $3 buys, how refunds work, who processes the payment, and how to reach the operator', async () => {
    const t = paidMode(db);
    const res = await t.get('/terms');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const page = await res.text();
    expect(page).toMatch(/\$3(\.00)? \(USD\)/);
    expect(page).toMatch(/one appeal/i);
    expect(page).toMatch(/new evidence/i);
    expect(page).toMatch(/refund/i);
    expect(page).toMatch(/14 days/);
    expect(page).toMatch(/Stripe/);
    expect(page).toMatch(/18/);
    expect(page).toMatch(/not legal advice/i);
    expect(page).toMatch(/30 days/);
    expect(page).toContain(`mailto:${CONTACT_EMAIL}`);
  });

  it('without a contact address, says so and that payments are off', async () => {
    const t = db.setup();
    const page = await (await t.get('/terms')).text();
    expect(page).toMatch(/payments are switched off/i);
    expect(page).not.toContain('mailto:');
  });
});

describe('/privacy', () => {
  it('lists what is stored, the processors, the cookie, retention and deletion', async () => {
    const t = paidMode(db);
    const res = await t.get('/privacy');
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const pattern of [
      /testimon/i,
      /jury/i,
      /pc_device/,
      /Google/,
      /Stripe/,
      /card details/i,
      /30 days/,
      /delete/i,
      /email/i,
      /report/i,
    ]) {
      expect(page).toMatch(pattern);
    }
    expect(page).toContain(`mailto:${CONTACT_EMAIL}`);
  });

  it('M5: says how visits are counted and what is kept after a case is deleted', async () => {
    const page = await (await db.setup().get('/privacy')).text();
    expect(page).toContain('pc_seen');
    expect(page).toMatch(/counted once/i);
    expect(page).toMatch(/anonymous/i);
    expect(page).toMatch(/no text, links? or ids?/i);
    // The old "no analytics" line would now be untrue.
    expect(page).not.toMatch(/no analytics/i);
  });
});

describe('links to the legal pages', () => {
  it('every page’s footer links to the terms and the privacy page', async () => {
    const t = paidMode(db);
    const filed = await t.ruledCase();
    for (const path of ['/', `/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`, `/jury/${filed.juryToken}`, `/plaintiff/${filed.plaintiffToken}`, '/deleted', '/terms', '/privacy', '/no-such-page']) {
      const page = await (await t.get(path)).text();
      expect(page, path).toContain('href="/terms"');
      expect(page, path).toContain('href="/privacy"');
    }
  });
});
