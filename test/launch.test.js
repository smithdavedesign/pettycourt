// Go-live: search and sharing (titles, descriptions, canonical, Open Graph/Twitter, JSON-LD, robots.txt,
// sitemap.xml, the 1200×630 share image), the legal pages' launch additions, the Payment Link's Buy
// button (hidden without STRIPE_PAYMENT_LINK), and RepoHQ's launch counts from the real client script.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeps } from '../src/config.js';
import { ISSUES_URL, PUBLIC_PAGES, SHARE_IMAGE } from '../src/seo.js';
import { CLIENT_JS, SIGNAL_URL } from '../src/views.js';
import { loadPage } from './dom.js';
import { NEW_EVIDENCE, pngSize, testDatabase } from './helpers.js';
import { CONTACT_EMAIL, paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

// A placeholder, like the screenshot run's: the real link only ever comes from the environment.
const PAYMENT_LINK = 'https://example.com/pay';
const SITE = 'https://pettycourt.example';
const PUBLIC_PATHS = ['/', '/terms', '/privacy'];

const ENTITIES = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s) => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (e) => ENTITIES[e]);

/** The content of `<meta {attr}="{name}" content="…">`, decoded, or null. */
function meta(page, name, attr = 'property') {
  const match = new RegExp(`<meta ${attr}="${name.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(page);
  return match ? decode(match[1]) : null;
}
const titleOf = (page) => decode(/<title>([^<]*)<\/title>/.exec(page)?.[1] ?? '');
const canonicalOf = (page) => /<link rel="canonical" href="([^"]*)">/.exec(page)?.[1] ?? null;
const jsonLdOf = (page) => {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page);
  return match ? JSON.parse(match[1]) : null;
};

describe('the public pages: titles, descriptions, canonical, cards and JSON-LD', () => {
  it('each has its own title and description, a canonical URL, Open Graph and Twitter tags with the share image', async () => {
    const t = db.setup({ siteOrigin: SITE });
    const titles = new Set();
    const descriptions = new Set();
    for (const path of PUBLIC_PATHS) {
      const res = await t.get(path);
      expect(res.status, path).toBe(200);
      const page = await res.text();
      const title = titleOf(page);
      const description = meta(page, 'description', 'name');
      expect(title, path).toBeTruthy();
      expect(description, path).toBeTruthy();
      titles.add(title);
      descriptions.add(description);

      expect(canonicalOf(page), path).toBe(`${SITE}${path}`);
      expect(meta(page, 'og:url'), path).toBe(`${SITE}${path}`);
      expect(meta(page, 'og:type'), path).toBe('website');
      expect(meta(page, 'og:site_name'), path).toBe('Group Chat Court');
      expect(meta(page, 'og:title'), path).toBe(title);
      expect(meta(page, 'og:description'), path).toBe(description);
      expect(meta(page, 'og:image'), path).toBe(`${SITE}/og.png`);
      expect(meta(page, 'og:image:width'), path).toBe('1200');
      expect(meta(page, 'og:image:height'), path).toBe('630');
      expect(meta(page, 'og:image:alt'), path).toBeTruthy();
      expect(meta(page, 'twitter:card', 'name'), path).toBe('summary_large_image');
      expect(meta(page, 'twitter:title', 'name'), path).toBe(title);
      expect(meta(page, 'twitter:description', 'name'), path).toBe(description);
      expect(meta(page, 'twitter:image', 'name'), path).toBe(`${SITE}/og.png`);
      // Public pages are meant to be found.
      expect(page, path).not.toContain('noindex');
    }
    expect(titles.size).toBe(PUBLIC_PATHS.length);
    expect(descriptions.size).toBe(PUBLIC_PATHS.length);
  });

  it('describes the product as a SoftwareApplication with a $3 one-time Offer, in JSON-LD', async () => {
    const t = db.setup({ siteOrigin: SITE });
    for (const path of PUBLIC_PATHS) {
      const data = jsonLdOf(await (await t.get(path)).text());
      expect(data, path).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Group Chat Court',
        url: `${SITE}/`,
        image: `${SITE}/og.png`,
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '3.00', priceCurrency: 'USD' },
      });
      expect(data.offers.description).toMatch(/once/i);
    }
  });

  it('without a configured origin, uses the request’s own; PUBLIC_URL (publicOrigin) comes next', async () => {
    const local = await (await db.setup().get('/terms')).text();
    expect(canonicalOf(local)).toBe('http://localhost/terms');
    expect(meta(local, 'og:image')).toBe('http://localhost/og.png');
    const proxied = await (await db.setup({ publicOrigin: 'https://pettycourt.onrender.com' }).get('/')).text();
    expect(canonicalOf(proxied)).toBe('https://pettycourt.onrender.com/');
  });

  it('a hostile Host header can’t break out of the JSON-LD or the tags', async () => {
    const t = db.setup();
    const res = await t.request('http://evil.example/', { headers: { host: 'evil.example' } });
    const page = await res.text();
    expect(jsonLdOf(page)).toMatchObject({ '@type': 'SoftwareApplication' });
    const { jsonLd } = await import('../src/seo.js');
    const text = jsonLd('https://x.example/</script><script>alert(1)</script>');
    expect(text).not.toContain('<');
    expect(JSON.parse(text).url).toBe('https://x.example/</script><script>alert(1)</script>/');
  });

  it('every other page stays noindex, with no canonical and no JSON-LD (a case is shared by link, never listed)', async () => {
    const t = db.setup({ siteOrigin: SITE });
    const filed = await t.ruledCase();
    for (const path of [`/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`, `/jury/${filed.juryToken}`, `/plaintiff/${filed.plaintiffToken}`, '/deleted', '/no-such-page']) {
      const page = await (await t.get(path)).text();
      expect(page, path).toContain('<meta name="robots" content="noindex">');
      expect(canonicalOf(page), path).toBeNull();
      expect(jsonLdOf(page), path).toBeNull();
      expect(page, path).not.toContain('/og.png');
    }
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('robots.txt allows crawling and points at the sitemap', async () => {
    const t = db.setup({ siteOrigin: SITE });
    const res = await t.get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toMatch(/^User-agent: \*$/m);
    expect(text).toMatch(/^Allow: \/$/m);
    expect(text).not.toMatch(/^Disallow: \/\s*$/m);
    expect(text).toMatch(new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, 'm'));
  });

  it('sitemap.xml lists exactly the public pages, by their canonical URLs', async () => {
    const t = db.setup({ siteOrigin: SITE });
    await t.ruledCase();
    const res = await t.get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/xml/);
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PUBLIC_PATHS.map((path) => `${SITE}${path}`));
    expect(Object.values(PUBLIC_PAGES).map((p) => p.path)).toEqual(PUBLIC_PATHS);
  });

  it('both are cacheable, unlike the case pages', async () => {
    const t = db.setup();
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      expect((await t.get(path)).headers.get('cache-control'), path).toMatch(/^public, max-age=\d+/);
    }
  });
});

describe('the share image', () => {
  it('/og.png is a 1200×630 PNG drawn by the app, cached for a day', async () => {
    const t = db.setup();
    const res = await t.get(SHARE_IMAGE.path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(pngSize(await res.arrayBuffer())).toEqual({ width: 1200, height: 630 });
    expect(SHARE_IMAGE).toMatchObject({ width: 1200, height: 630 });
  });

  it('a failed render answers 500, and the next request tries again', async () => {
    const renderShare = vi.fn().mockRejectedValueOnce(new Error('wasm missing')).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createApp } = await import('../src/app.js');
    const app = createApp({ store: db.store, judge: async () => '', renderShare });
    expect((await app.request('/og.png')).status).toBe(500);
    expect((await app.request('/og.png')).status).toBe(200);
    expect(errors.mock.calls.flat().map(String).join(' ')).toMatch(/wasm missing/);
    errors.mockRestore();
  });
});

describe('the legal pages at launch', () => {
  it('terms: the price once, refunds, no warranty, and contact through the repo’s issues', async () => {
    const page = await (await db.setup().get('/terms')).text();
    expect(page).toMatch(/\$3\.00 \(USD\), once/);
    expect(page).toMatch(/no subscription/i);
    expect(page).toMatch(/refunds/i);
    expect(page).toMatch(/within 14 days/);
    expect(page).toMatch(/<h2>No warranty<\/h2>/);
    expect(page).toMatch(/provided as is, without warranty/i);
    expect(page).toContain(`href="${ISSUES_URL}"`);
    // Without an email, refunds go through a public issue: the receipt number, never the appeal link.
    expect(page).toMatch(/receipt number/i);
    expect(page).toMatch(/don't post your appeal link/i);
  });

  it('privacy: names the three launch counts, where they go, what they hold, the opt-out and the one cookie', async () => {
    const page = await (await db.setup().get('/privacy')).text();
    for (const kind of ['visit', 'activate', 'checkout']) expect(page).toContain(`<strong>${kind}</strong>`);
    expect(page).toContain('idea-factory.1426davejobs.workers.dev');
    expect(page).toContain('repohq:notrack');
    expect(page).toMatch(/once per browser session/i);
    expect(page).toMatch(/never holds a link to a case/i);
    expect(page).toMatch(/<h2>Cookies<\/h2>\n<p>Only one/);
    expect(page).toContain('pc_device');
    expect(page).toContain(`href="${ISSUES_URL}"`);
  });

  it('every page’s footer links to the terms, the privacy page and the contact', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    for (const path of ['/', `/cases/${filed.caseId}`, `/jury/${filed.juryToken}`, '/terms', '/privacy', '/deleted', '/no-such-page']) {
      const footer = /<footer>[\s\S]*<\/footer>/.exec(await (await t.get(path)).text())?.[0] ?? '';
      expect(footer, path).toContain('href="/terms"');
      expect(footer, path).toContain('href="/privacy"');
      expect(footer, path).toContain(`href="${ISSUES_URL}"`);
    }
  });
});

const clicksFor = (caseId) => db.sql('SELECT id, checkout_session_id, paid_at FROM unlock_clicks WHERE case_id = $1', [caseId]);
const buyForm = (caseId) => `<form data-api="/cases/${caseId}/checkout" data-then="redirect" data-buy`;

describe('the Buy button (STRIPE_PAYMENT_LINK)', () => {
  it('is hidden without the env var: a ruled case keeps the fake door, and checkout is 503', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('data-buy');
    expect(page).not.toContain('Buy the appeal');
    expect(page).not.toContain('example.com/pay');
    expect(page).toContain(`data-api="/cases/${filed.caseId}/unlock"`);
    expect((await t.checkout(filed.caseId)).status).toBe(503);
  });

  it('with the env var, a ruled case offers "Buy the appeal · $3"; before the ruling there is no button', async () => {
    const t = db.setup({ paymentLink: PAYMENT_LINK });
    const waiting = await t.fileCase();
    const before = await (await t.get(`/cases/${waiting.caseId}`)).text();
    expect(before).not.toContain('data-buy');
    expect(before).not.toContain('/unlock"');
    expect(before).toMatch(/After the ruling, either side can appeal once for \$3/);

    const filed = await t.ruledCase();
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain(buyForm(filed.caseId));
    expect(page).toContain('<button>Buy the appeal · $3</button>');
    expect(page).toMatch(/email you the link to file your appeal within 2 days/);
    expect(page).not.toContain('/unlock"');
  });

  it('clicking it records one click and answers the Payment Link with the click id as client_reference_id', async () => {
    const t = db.setup({ paymentLink: `${PAYMENT_LINK}?prefilled_promo_code=COURT` });
    const filed = await t.ruledCase();
    const outbound = vi.spyOn(globalThis, 'fetch');
    const res = await t.checkout(filed.caseId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe(PAYMENT_LINK);
    expect(url.searchParams.get('prefilled_promo_code')).toBe('COURT');
    expect(url.searchParams.get('client_reference_id')).toBe(body.clickId);
    expect(await clicksFor(filed.caseId)).toEqual([{ id: body.clickId, checkout_session_id: null, paid_at: null }]);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockRestore();
    // An unpaid Payment Link click has no appeal page yet: the operator sends it once the payment is confirmed.
    expect((await t.get(`/appeals/${body.clickId}`)).status).toBe(404);
  });

  it('refuses what M4 refuses (409 for an unruled case), and 404 for no such case, storing nothing', async () => {
    const t = db.setup({ paymentLink: PAYMENT_LINK });
    const waiting = await t.fileCase();
    expect((await t.checkout(waiting.caseId)).status).toBe(409);
    expect(await clicksFor(waiting.caseId)).toHaveLength(0);
    expect((await t.checkout('x'.repeat(16))).status).toBe(404);
  });

  it('the operator’s manual confirmation (LAUNCH-READY.md) opens the appeal page, and the appeal is heard once', async () => {
    const t = db.setup({ paymentLink: PAYMENT_LINK });
    const filed = await t.ruledCase();
    const { clickId } = await (await t.checkout(filed.caseId)).json();
    // The SQL from LAUNCH-READY.md, with the click id Stripe shows as client_reference_id.
    const sessionId = ['cs', 'live', 'A1b2C3d4'.repeat(4)].join('_');
    const marked = await db.sql(
      `WITH paid AS (
         UPDATE unlock_clicks SET paid_at = now(), checkout_session_id = $2
         WHERE id = $1 AND paid_at IS NULL
         RETURNING case_id
       )
       UPDATE cases SET paid_at = now() FROM paid WHERE cases.id = paid.case_id AND cases.paid_at IS NULL
       RETURNING cases.id`,
      [clickId, sessionId],
    );
    expect(marked).toEqual([{ id: filed.caseId }]);

    const appealPage = await t.get(`/appeals/${clickId}`);
    expect(appealPage.status).toBe(200);
    const page = await appealPage.text();
    expect(page).toMatch(/Paid \$3\.00 on/);
    expect(page).not.toMatch(/Stripe emails your receipt, with a link back/);
    expect(page).toContain(`data-api="/cases/${filed.caseId}/appeal"`);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
    expect(await (await t.get(`/cases/${filed.caseId}`)).text()).toMatch(/from the link we emailed them/);

    expect((await t.appeal(filed.caseId, clickId, { side: 'defendant', evidence: NEW_EVIDENCE })).status).toBe(201);
    expect((await t.appeal(filed.caseId, clickId, { side: 'defendant', evidence: NEW_EVIDENCE })).status).toBe(409);
  });

  it('Stripe Checkout, when configured, wins over the Payment Link', async () => {
    const t = paidMode(db, { paymentLink: PAYMENT_LINK });
    const filed = await t.ruledCase();
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain(buyForm(filed.caseId));
    expect(page).toContain('Appeal the verdict · $3');
    const { url } = await t.startCheckout(filed.caseId);
    expect(url.startsWith('https://checkout.stripe.com/')).toBe(true);
  });

  it('the terms and privacy pages explain the manual confirmation and the payer’s email', async () => {
    const t = db.setup({ paymentLink: PAYMENT_LINK, contactEmail: CONTACT_EMAIL });
    const terms = await (await t.get('/terms')).text();
    expect(terms).not.toMatch(/payments are switched off/i);
    expect(terms).toMatch(/We confirm payments by hand/);
    expect(terms).toContain(`mailto:${CONTACT_EMAIL}`);
    const privacy = await (await t.get('/privacy')).text();
    expect(privacy).toMatch(/Stripe shows us the email address you pay with/);
  });

  it('no payment link or key is hard-coded in the source', () => {
    const src = new URL('../src/', import.meta.url);
    for (const file of readdirSync(src)) {
      const text = readFileSync(new URL(file, src), 'utf8');
      expect(text, file).not.toMatch(/buy\.stripe\.com|example\.com\/pay|\b[sp]k_(live|test)_/);
    }
  });
});

describe('createDeps: go-live settings', () => {
  it('takes STRIPE_PAYMENT_LINK, else NEXT_PUBLIC_STRIPE_PAYMENT_LINK, as an https URL; anything else hides the button', () => {
    expect(createDeps({}).paymentLink).toBeNull();
    expect(createDeps({}).paymentsKind).toBe('off');
    const deps = createDeps({ STRIPE_PAYMENT_LINK: ` ${PAYMENT_LINK} ` });
    expect(deps.paymentLink).toBe(PAYMENT_LINK);
    expect(deps.paymentsKind).toBe('link');
    expect(createDeps({ NEXT_PUBLIC_STRIPE_PAYMENT_LINK: PAYMENT_LINK }).paymentLink).toBe(PAYMENT_LINK);
    expect(createDeps({ STRIPE_PAYMENT_LINK: PAYMENT_LINK, NEXT_PUBLIC_STRIPE_PAYMENT_LINK: 'https://other.example/x' }).paymentLink).toBe(PAYMENT_LINK);
    for (const bad of ['http://example.com/pay', 'example.com/pay', 'javascript:alert(1)', '']) {
      expect(createDeps({ STRIPE_PAYMENT_LINK: bad }).paymentLink, bad).toBeNull();
    }
  });

  it('turns the launch counts on for production only: NEXT_PUBLIC_DEPLOY_ENV, else NEXT_PUBLIC_VERCEL_ENV, else VERCEL_ENV', () => {
    expect(createDeps({}).signal).toBe(false);
    expect(createDeps({ NEXT_PUBLIC_DEPLOY_ENV: 'production' }).signal).toBe(true);
    expect(createDeps({ NEXT_PUBLIC_VERCEL_ENV: 'production' }).signal).toBe(true);
    expect(createDeps({ VERCEL_ENV: 'production' }).signal).toBe(true);
    expect(createDeps({ VERCEL_ENV: 'preview' }).signal).toBe(false);
    expect(createDeps({ NEXT_PUBLIC_DEPLOY_ENV: 'preview', VERCEL_ENV: 'production' }).signal).toBe(false);
    expect(createDeps({ NEXT_PUBLIC_DEPLOY_ENV: 'Production' }).signal).toBe(false);
  });

  it('the canonical origin: PUBLIC_URL or Render’s URL, else Vercel’s production host, else none (the request’s)', () => {
    expect(createDeps({}).siteOrigin).toBeNull();
    expect(createDeps({ VERCEL_PROJECT_PRODUCTION_URL: 'pettycourt.vercel.app' }).siteOrigin).toBe('https://pettycourt.vercel.app');
    expect(
      createDeps({ PUBLIC_URL: 'https://court.example', VERCEL_PROJECT_PRODUCTION_URL: 'pettycourt.vercel.app' }).siteOrigin,
    ).toBe('https://court.example');
    expect(createDeps({ RENDER_EXTERNAL_URL: 'https://pettycourt.onrender.com' }).siteOrigin).toBe('https://pettycourt.onrender.com');
  });
});

describe('the content security policy', () => {
  it('lets the pages reach RepoHQ’s counter only when the launch counts are on', async () => {
    const csp = async (t) => (await t.get('/')).headers.get('content-security-policy');
    expect(await csp(db.setup())).toMatch(/connect-src 'self'(;|$)/);
    expect(await csp(db.setup({ signal: true }))).toMatch(
      /connect-src 'self' https:\/\/idea-factory\.1426davejobs\.workers\.dev(;|$)/,
    );
  });
});

// ── RepoHQ's launch counts, from the real client script ──────────────────────────────────────────────

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

/** A browser: its own localStorage, and a sessionStorage that `newSession()` replaces (a closed tab). */
function browser() {
  const b = { localStorage: memoryStorage(), sessionStorage: memoryStorage() };
  b.newSession = () => {
    b.sessionStorage = memoryStorage();
  };
  return b;
}

/**
 * Open `path` in `b` with the /app.js the app serves. Requests to RepoHQ are recorded, never sent; the
 * rest go to the app (without the browser-only transport options, which Node's Request refuses).
 */
async function open(t, path, b, { referrer = '', webdriver = false, storage = true } = {}) {
  const script = await (await t.get('/app.js')).text();
  const res = await t.get(path);
  const signals = [];
  const fetch = vi.fn((url, init = {}) => {
    if (url === SIGNAL_URL) {
      signals.push({ init, body: JSON.parse(init.body) });
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const { keepalive, mode, credentials, referrerPolicy, ...rest } = init;
    return t.app.request(url, rest);
  });
  const page = loadPage(await res.text(), {
    fetch,
    script,
    referrer,
    webdriver,
    ...(storage ? { localStorage: b.localStorage, sessionStorage: b.sessionStorage } : {}),
  });
  return { ...page, signals, fetch };
}

const kinds = (signals) => signals.map((s) => s.body.kind);

describe('RepoHQ launch counts (production only)', () => {
  it('"visit": once per browser session, as a keepalive, cookieless, Referer-less JSON POST of slug, kind and referrer', async () => {
    const t = db.setup({ signal: true });
    const b = browser();
    const first = await open(t, '/', b);
    expect(first.signals).toHaveLength(1);
    const [{ init, body }] = first.signals;
    expect(body).toEqual({ slug: 'pettycourt', kind: 'visit', referrer: null });
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'no-cors', referrerPolicy: 'no-referrer' });
    expect(init.headers['content-type']).toMatch(/^text\/plain/);

    expect((await open(t, '/terms', b)).signals).toHaveLength(0);
    expect((await open(t, '/privacy', b)).signals).toHaveLength(0);
    b.newSession();
    expect(kinds((await open(t, '/', b)).signals)).toEqual(['visit']);
    expect(kinds((await open(t, '/', browser())).signals)).toEqual(['visit']);
  });

  it('counts a visit on a case’s pages too, without ever sending the page’s address or token', async () => {
    const t = db.setup({ signal: true });
    const filed = await t.fileCase();
    const juror = await open(t, `/jury/${filed.juryToken}`, browser(), { referrer: `http://localhost/summons/${filed.summonsToken}` });
    expect(juror.signals).toHaveLength(1);
    expect(juror.signals[0].body).toEqual({ slug: 'pettycourt', kind: 'visit', referrer: null });
    expect(juror.signals[0].init.body).not.toContain(filed.juryToken);
    expect(juror.signals[0].init.body).not.toContain(filed.summonsToken);
  });

  it('sends the referrer only when it comes from another site', async () => {
    const t = db.setup({ signal: true });
    const external = await open(t, '/', browser(), { referrer: 'https://news.ycombinator.com/item?id=1' });
    expect(external.signals[0].body.referrer).toBe('https://news.ycombinator.com/item?id=1');
    const internal = await open(t, '/', browser(), { referrer: 'http://localhost/terms' });
    expect(internal.signals[0].body.referrer).toBeNull();
  });

  it('"activate": the first case this browser files, once per browser', async () => {
    const t = db.setup({ signal: true });
    const b = browser();
    const fileFrom = async () => {
      const page = await open(t, '/', b);
      const form = page.form('/cases');
      form.querySelector('[name="charge"]').value = 'Ate the last dumpling without asking the table';
      form.querySelector('[name="testimony"]').value = 'There were witnesses.';
      await page.submit(form);
      expect(page.document.getElementById('filed').hidden).toBe(false);
      return page;
    };
    const first = await fileFrom();
    expect(kinds(first.signals)).toEqual(['visit', 'activate']);
    expect(b.localStorage.getItem('repohq:activated')).not.toBeNull();
    expect(kinds((await fileFrom()).signals)).toEqual([]);

    // A failed filing activates nothing.
    const other = browser();
    const page = await open(t, '/', other);
    await page.submit(page.form('/cases'));
    expect(kinds(page.signals)).toEqual(['visit']);
  });

  it('"checkout": each press of the Buy button, before the browser leaves for the Payment Link', async () => {
    const t = db.setup({ signal: true, paymentLink: PAYMENT_LINK });
    const filed = await t.ruledCase();
    const b = browser();
    const page = await open(t, `/cases/${filed.caseId}`, b);
    await page.submit(page.form(`/cases/${filed.caseId}/checkout`));
    expect(kinds(page.signals)).toEqual(['visit', 'checkout']);
    expect(page.location.assigned).toHaveLength(1);
    expect(page.location.assigned[0].startsWith(`${PAYMENT_LINK}?client_reference_id=`)).toBe(true);
  });

  it('the fake door (no payment link) is not a Buy button and sends no "checkout"', async () => {
    const t = db.setup({ signal: true });
    const filed = await t.ruledCase();
    const page = await open(t, `/cases/${filed.caseId}`, browser());
    await page.submit(page.form(`/cases/${filed.caseId}/unlock`));
    expect(kinds(page.signals)).toEqual(['visit']);
  });

  it('sends nothing from an automated browser, the owner’s browser (repohq:notrack) or a browser without storage', async () => {
    const t = db.setup({ signal: true, paymentLink: PAYMENT_LINK });
    const filed = await t.ruledCase();

    const robot = await open(t, `/cases/${filed.caseId}`, browser(), { webdriver: true });
    await robot.submit(robot.form(`/cases/${filed.caseId}/checkout`));
    expect(robot.signals).toEqual([]);

    const owner = browser();
    owner.localStorage.setItem('repohq:notrack', '1');
    const mine = await open(t, `/cases/${filed.caseId}`, owner);
    await mine.submit(mine.form(`/cases/${filed.caseId}/checkout`));
    expect(mine.signals).toEqual([]);

    const noStorage = await open(t, '/', browser(), { storage: false });
    expect(noStorage.signals).toEqual([]);
  });

  it('sends nothing on anything but the production build', async () => {
    const t = db.setup({ paymentLink: PAYMENT_LINK });
    const filed = await t.ruledCase();
    const page = await open(t, `/cases/${filed.caseId}`, browser());
    await page.submit(page.form(`/cases/${filed.caseId}/checkout`));
    expect(page.signals).toEqual([]);
    expect(page.location.assigned).toHaveLength(1);
    expect(CLIENT_JS).toContain('const SIGNAL_ON = false;');
    expect(await (await db.setup({ signal: true }).get('/app.js')).text()).toContain('const SIGNAL_ON = true;');
  });
});
