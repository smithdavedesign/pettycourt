// Full trial over real HTTP through the Node adapter, wired exactly like scripts/dev.js
// (local config: PGlite in memory + the stub judge). No network beyond 127.0.0.1.
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDeps } from '../src/config.js';

let server;
let base;
let deps;

beforeAll(async () => {
  deps = createDeps({}, { local: true, pgliteDir: 'memory://' });
  const app = createApp({ store: deps.store, judge: deps.judge });
  await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await deps.close();
});

const postJson = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a whole trial over HTTP', () => {
  it('file → summons → testimony → rule → results page', async () => {
    const filed = await postJson('/cases', {
      title: 'The Shower Affair',
      charge: 'Said "five minutes away" while still in the shower',
      testimony: 'I waited forty minutes outside the cinema.',
    });
    expect(filed.status).toBe(201);
    const { caseId, summonsUrl, caseUrl } = await filed.json();
    expect(summonsUrl.startsWith(base)).toBe(true);
    expect(caseUrl).toBe(`${base}/cases/${caseId}`);

    const summons = await fetch(summonsUrl);
    expect(summons.status).toBe(200);
    expect(await summons.text()).toContain('five minutes away');

    const answer = await postJson(`${new URL(summonsUrl).pathname}/testimony`, { testimony: 'I was mentally en route.' });
    expect(answer.status).toBe(201);
    expect((await answer.json()).caseUrl).toBe(caseUrl);

    const ruled = await postJson(`/cases/${caseId}/rule`, {});
    expect(ruled.status).toBe(200);
    const ruling = await ruled.json();
    expect(ruling.verdict).toBe('split');
    const count = ruling.ruling.split(/\s+/).length;
    expect(count).toBeGreaterThanOrEqual(40);
    expect(count).toBeLessThanOrEqual(200);

    const page = await fetch(caseUrl);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Verdict: Split decision');
    expect(text).toContain('I was mentally en route.');
  });

  it('file → three jurors vote with their own cookies → split on the page → card.png', async () => {
    const filed = await postJson('/cases', {
      charge: 'Ate the last dumpling while I was in the shower',
      testimony: 'I had labelled the container.',
    });
    expect(filed.status).toBe(201);
    const { caseId, caseUrl, juryUrl } = await filed.json();
    expect(juryUrl.startsWith(`${base}/jury/`)).toBe(true);

    const juryPage = await fetch(juryUrl);
    expect(juryPage.status).toBe(200);
    expect(await juryPage.text()).toContain('name="vote"');

    const votesPath = `${new URL(juryUrl).pathname}/votes`;
    const cookies = [];
    for (const vote of ['guilty', 'not_guilty', 'guilty']) {
      const res = await postJson(votesPath, { vote, comment: `I say ${vote}` });
      expect(res.status).toBe(201);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(/^pc_device=/);
      cookies.push(cookie.split(';')[0]);
    }
    const repeat = await fetch(base + votesPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies[0] },
      body: JSON.stringify({ vote: 'not_guilty' }),
    });
    expect(repeat.status).toBe(409);

    const page = await (await fetch(caseUrl)).text();
    expect(page).toContain('2 guilty · 1 not guilty');

    const card = await fetch(`${base}/cases/${caseId}/card.png`);
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await card.arrayBuffer());
    expect(bytes.readUInt32BE(16)).toBe(1080);
    expect(bytes.readUInt32BE(20)).toBe(1350);
  });

  it('file → plaintiff page → unlock click → delete with the plaintiff token → everything 404s', async () => {
    const filed = await postJson('/cases', {
      charge: 'Finished the series without me',
      testimony: 'We had a pact. The pact was sacred.',
    });
    expect(filed.status).toBe(201);
    const { caseId, caseUrl, summonsUrl, juryUrl, plaintiffUrl, plaintiffToken } = await filed.json();
    expect(plaintiffUrl).toBe(`${base}/plaintiff/${plaintiffToken}`);

    const desk = await fetch(plaintiffUrl);
    expect(desk.status).toBe(200);
    const deskPage = await desk.text();
    expect(deskPage).toContain(summonsUrl);
    expect(deskPage).toContain(juryUrl);

    const click = await postJson(`/cases/${caseId}/unlock`, {});
    expect(click.status).toBe(200);
    expect((await click.json()).charged).toBe(false);

    const deleted = await fetch(`${base}/cases/${caseId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${plaintiffToken}` },
    });
    expect(deleted.status).toBe(200);
    for (const url of [caseUrl, `${caseUrl}/card.png`, summonsUrl, juryUrl, plaintiffUrl]) {
      expect((await fetch(url)).status, url).toBe(404);
    }
  });

  it('runs the expiry job over HTTP', async () => {
    const res = await fetch(`${base}/cron/expire`);
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(0);
  });

  it('M4: checkout → payment → a signed webhook through the adapter (raw bytes) → appeal → case page', async () => {
    const { createStripe } = await import('../src/payments.js');
    const { FAKE_STRIPE_KEY, FAKE_WEBHOOK_SECRET, fakeStripe } = await import('./stripe.js');
    const stripe = fakeStripe();
    const paid = createApp({
      store: deps.store,
      judge: deps.judge,
      payments: createStripe({ secretKey: FAKE_STRIPE_KEY, webhookSecret: FAKE_WEBHOOK_SECRET, fetch: stripe.fetch }),
      contactEmail: 'court@example.com',
    });
    let paidBase;
    const paidServer = await new Promise((resolve) => {
      const s = serve({ fetch: paid.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        paidBase = `http://127.0.0.1:${info.port}`;
        resolve(s);
      });
    });
    const postTo = (path, body, headers = {}) =>
      fetch(paidBase + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const { caseId, summonsToken } = await (await postTo('/cases', { charge: 'Spoiled the finale', testimony: 'In the group chat.' })).json();
      await postTo(`/summons/${summonsToken}/testimony`, { testimony: 'It was a hypothetical spoiler.' });
      expect((await postTo(`/cases/${caseId}/rule`, {})).status).toBe(200);

      const checkout = await postTo(`/cases/${caseId}/checkout`, {});
      expect(checkout.status).toBe(200);
      const { clickId, url } = await checkout.json();
      const [session] = stripe.created();
      expect(url).toBe(session.url);
      expect(session.success_url).toBe(`${paidBase}/appeals/${clickId}`);

      stripe.pay(session.id);
      // Non-ASCII in the body makes any re-encoding between the socket and the signature check fail.
      const { body, signature } = stripe.event('checkout.session.completed', session.id, {
        atSeconds: Math.floor(Date.now() / 1000),
      });
      const withAccents = body.replace('"object":"event"', '"object":"event","note":"Café ☕ — déjà vu"');
      const resigned = (await import('./stripe.js')).signPayload(withAccents, { atSeconds: Math.floor(Date.now() / 1000) });
      const hook = await fetch(`${paidBase}/stripe/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': resigned },
        body: Buffer.from(withAccents, 'utf8'),
      });
      expect(hook.status).toBe(200);
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

      const appeal = await postTo(
        `/cases/${caseId}/appeal`,
        { side: 'defendant', evidence: 'The trailer spoiled it first.' },
        { authorization: `Bearer ${clickId}` },
      );
      expect(appeal.status).toBe(201);
      expect((await appeal.json()).heard).toBe(true);
      const page = await (await fetch(`${paidBase}/cases/${caseId}`)).text();
      expect(page).toContain('Verdict on appeal');
      expect(page).toContain('The trailer spoiled it first.');
      expect((await postTo(`/cases/${caseId}/appeal`, { side: 'plaintiff', evidence: 'Again.' }, { authorization: `Bearer ${clickId}` })).status).toBe(409);
    } finally {
      await new Promise((resolve) => paidServer.close(resolve));
    }
  });

  it('serves the home page and assets through the adapter', async () => {
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/app.css`)).status).toBe(200);
  });
});
