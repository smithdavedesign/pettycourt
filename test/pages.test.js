import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, judgeReply, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const XSS = '<script>alert("pwned")</script>';

describe('home page', () => {
  it('serves the filing form', async () => {
    const t = db.setup();
    const res = await t.get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const page = await res.text();
    expect(page).toContain('data-api="/cases"');
    for (const field of ['title', 'charge', 'testimony']) expect(page).toContain(`name="${field}"`);
    expect(page).toContain('maxlength="280"');
    expect(page).toMatch(/18/);
    expect(page).toMatch(/petty/i);
    expect(page).toContain('<script src="/app.js" defer></script>');
    expect(page).toContain('href="/app.css"');
  });
});

describe('static assets', () => {
  it('serves the client script and stylesheet with long-ish caching', async () => {
    const t = db.setup();
    const js = await t.get('/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toContain('data-api');
    expect(js.headers.get('cache-control')).toMatch(/max-age=\d+/);

    const css = await t.get('/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/text\/css/);
  });
});

describe('security headers', () => {
  it('sets a strict CSP, no-referrer and no-store on case pages', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const path of [`/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`]) {
      const res = await t.get(path);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/script-src 'self'/);
      expect(csp).not.toMatch(/unsafe-inline/);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('<meta name="robots" content="noindex">');
    }
  });

  it('marks API responses no-store too', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: 'Took the last slice', testimony: 'It was mine.' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('HTML escaping', () => {
  it('renders a <script> charge and testimony as text on the case and summons pages', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: XSS, charge: XSS, testimony: XSS });
    await t.answer(filed.summonsToken, XSS);
    for (const path of [`/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`]) {
      const page = await (await t.get(path)).text();
      expect(page).not.toContain('<script>alert');
      expect(page).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
    }
  });

  it('renders model output as text', async () => {
    const ruling = `<img src=x onerror=alert(1)> ${'Order in the court. '.repeat(12)}`;
    const t = db.setup({ judge: async () => judgeReply('guilty', ruling) });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('case page states', () => {
  it('waiting: shows the deadline and no judge button', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(1 * HOUR);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/waiting for the defendant/i);
    expect(page).toMatch(/23 hours/);
    expect(page).not.toContain(`data-api="/cases/${filed.caseId}/rule"`);
    // The public results page must never reveal the summons link.
    expect(page).not.toContain(filed.summonsToken);
    expect(page).not.toContain(filed.juryToken);
  });

  it('ready: both sides testified, offers the judge button', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken, 'I was mentally en route.');
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('I was mentally en route.');
    expect(page).toContain(`data-api="/cases/${filed.caseId}/rule"`);
  });

  it('no-show: after the deadline, offers the judge button and says the defendant failed to appear', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(24 * HOUR + 1);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/failed to appear/i);
    expect(page).toContain(`data-api="/cases/${filed.caseId}/rule"`);
  });

  it('ruled: shows the verdict and ruling, no judge button', async () => {
    const t = db.setup({ judge: async () => judgeReply('guilty') });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/guilty/i);
    expect(page).toContain('Court is adjourned.');
    expect(page).not.toContain(`data-api="/cases/${filed.caseId}/rule"`);
    expect(page).toMatch(/not legal advice/i);
  });

  it('labels a not-guilty verdict', async () => {
    const t = db.setup({ judge: async () => judgeReply('not_guilty') });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/not guilty/i);
  });
});

describe('summons page states', () => {
  it('after the deadline but before a ruling, still lets the defendant answer', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(30 * HOUR);
    const page = await (await t.get(`/summons/${filed.summonsToken}`)).text();
    expect(page).toContain('name="testimony"');
    expect(page).toMatch(/deadline has passed/i);
  });
});
