import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderCardPng } from '../src/card.js';
import { HOUR, nearMiss, newDevice, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const TITLE = 'The Great Thermostat Cold War';
const CHARGE = 'Turned the heating down to 16 degrees every night';
const PLAINTIFF = 'I woke up wearing two jumpers and a hat.';
const DEFENDANT = 'Sixteen degrees is a perfectly civilised sleeping temperature.';
const COMMENTS = ['Hats indoors are evidence.', 'Sixteen is bracing.', 'Buy a blanket.'];
const EMAIL = 'plaintiff@example.com';

/** A case with everything M1–M3 can attach to it: both testimonies, a ruling, votes, a card, a click with an email. */
async function fullCase(t) {
  const filed = await t.fileCase({ title: TITLE, charge: CHARGE, testimony: PLAINTIFF });
  expect((await t.answer(filed.summonsToken, DEFENDANT)).status).toBe(201);
  expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
  for (const [i, vote] of ['guilty', 'guilty', 'not_guilty'].entries()) {
    expect((await t.vote(filed.juryToken, { vote, comment: COMMENTS[i] }, newDevice())).status).toBe(201);
  }
  const card = await t.get(`/cases/${filed.caseId}/card.png`);
  expect(card.status).toBe(200);
  const click = await t.unlock(filed.caseId);
  expect(click.status).toBe(200);
  const { clickId } = await click.json();
  expect((await t.unlockEmail(filed.caseId, { clickId, email: EMAIL })).status).toBe(200);
  expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 1, votes: 3, reports: 0, unlock_clicks: 1 });
  return { ...filed, etag: card.headers.get('etag') };
}

/** Every route that reads or writes this case, with what it must say once the case is gone. */
async function expectGoneEverywhere(t, filed) {
  const checks = [
    ['GET case page', t.get(`/cases/${filed.caseId}`)],
    ['GET card', t.get(`/cases/${filed.caseId}/card.png`)],
    ['GET card with the old ETag', t.get(`/cases/${filed.caseId}/card.png`, { 'if-none-match': filed.etag ?? '*' })],
    ['GET summons', t.get(`/summons/${filed.summonsToken}`)],
    ['POST testimony', t.answer(filed.summonsToken, 'Let me answer after all.')],
    ['GET jury page', t.get(`/jury/${filed.juryToken}`)],
    ['POST vote', t.vote(filed.juryToken, { vote: 'guilty' }, newDevice())],
    ['GET plaintiff page', t.get(`/plaintiff/${filed.plaintiffToken}`)],
    ['POST rule', t.post(`/cases/${filed.caseId}/rule`)],
    ['POST unlock', t.unlock(filed.caseId)],
    ['POST report', t.report(filed.caseId)],
    ['DELETE again (plaintiff)', t.deleteCase(filed.caseId, filed.plaintiffToken)],
    ['DELETE again (defendant)', t.deleteCase(filed.caseId, filed.summonsToken)],
  ];
  for (const [name, pending] of checks) {
    const res = await pending;
    expect(res.status, name).toBe(404);
    const body = await res.text();
    for (const secret of [TITLE, CHARGE, PLAINTIFF, DEFENDANT, ...COMMENTS, EMAIL]) {
      expect(body, `${name} leaks "${secret}"`).not.toContain(secret);
    }
  }
}

describe('M3 exit criterion: DELETE with the plaintiff token removes the case, testimonies, votes and card', () => {
  it('deletes everything, and every route returns 404 afterwards', async () => {
    const cardCache = new Map();
    const t = db.setup({ cardCache, renderCard: renderCardPng });
    const filed = await fullCase(t);
    expect(cardCache.has(filed.caseId)).toBe(true);

    const res = await t.deleteCase(filed.caseId, filed.plaintiffToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caseId: filed.caseId, deleted: true });

    await expectGoneEverywhere(t, filed);

    // Testimonies are columns on the case row; votes (with their comments), clicks (with the email)
    // and reports are child rows. None is left, and the rendered card is gone from the cache.
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    for (const text of [PLAINTIFF, DEFENDANT]) {
      const found = await db.sql(
        'SELECT count(*)::int AS n FROM cases WHERE plaintiff_testimony = $1 OR defendant_testimony = $1',
        [text],
      );
      expect(found[0].n).toBe(0);
    }
    expect((await db.sql('SELECT count(*)::int AS n FROM votes WHERE comment = ANY($1)', [COMMENTS]))[0].n).toBe(0);
    expect((await db.sql('SELECT count(*)::int AS n FROM unlock_clicks WHERE email = $1', [EMAIL]))[0].n).toBe(0);
    expect(cardCache.has(filed.caseId)).toBe(false);
  });

  it('leaves other cases alone', async () => {
    const t = db.setup();
    const doomed = await t.fileCase();
    const other = await t.fileCase({ title: 'Someone else entirely' });
    await t.vote(other.juryToken, { vote: 'guilty' }, newDevice());
    expect((await t.deleteCase(doomed.caseId, doomed.plaintiffToken)).status).toBe(200);
    expect((await t.get(`/cases/${other.caseId}`)).status).toBe(200);
    expect(await db.rowsFor(other.caseId)).toEqual({ cases: 1, votes: 1, reports: 0, unlock_clicks: 0 });
  });
});

describe('the defendant can delete too', () => {
  it('DELETE with the summons token removes the case the same way', async () => {
    const cardCache = new Map();
    const t = db.setup({ cardCache, renderCard: renderCardPng });
    const filed = await fullCase(t);
    const res = await t.deleteCase(filed.caseId, filed.summonsToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caseId: filed.caseId, deleted: true });
    await expectGoneEverywhere(t, filed);
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    expect(cardCache.has(filed.caseId)).toBe(false);
  });

  it('works before the defendant has answered, after a decline and after a takedown', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });

    const unanswered = await t.fileCase();
    expect((await t.deleteCase(unanswered.caseId, unanswered.summonsToken)).status).toBe(200);

    const declined = await t.fileCase();
    await t.answer(declined.summonsToken);
    expect((await t.post(`/cases/${declined.caseId}/rule`)).status).toBe(422);
    expect((await t.deleteCase(declined.caseId, declined.plaintiffToken)).status).toBe(200);

    const reported = await t.fileCase();
    expect((await t.report(reported.caseId)).status).toBe(201);
    expect((await t.deleteCase(reported.caseId, reported.summonsToken)).status).toBe(200);

    for (const filed of [unanswered, declined, reported]) {
      expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    }
  });
});

describe('who may not delete', () => {
  it('a request with no Authorization header gets 401 and the case stays', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.deleteCase(filed.caseId);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect((await res.json()).error).toMatch(/plaintiff|summons/i);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
  });

  it('the jury token, the case id, near misses, other cases and other schemes get 404 and the case stays', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const other = await t.fileCase({ title: 'Another case' });
    const attempts = [
      ['jury token', filed.juryToken],
      ['case id', filed.caseId],
      ['near-miss plaintiff token', nearMiss(filed.plaintiffToken)],
      ['near-miss summons token', nearMiss(filed.summonsToken)],
      ["another case's plaintiff token", other.plaintiffToken],
      ["another case's summons token", other.summonsToken],
      ['malformed token', 'not-a-token'],
      ['empty token', ''],
    ];
    for (const [name, token] of attempts) {
      const res = await t.deleteCase(filed.caseId, token);
      expect(res.status, name).toBe(404);
      expect(await res.text(), name).not.toContain('five minutes away');
    }
    // A real token under another scheme is not a bearer credential at all.
    const basic = await t.deleteCase(filed.caseId, filed.plaintiffToken, { scheme: 'Basic' });
    expect(basic.status).toBe(401);
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 1 });
    expect(await db.rowsFor(other.caseId)).toMatchObject({ cases: 1 });
  });

  it('a malformed or unknown case id gets 404', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const id of ['short', 'x'.repeat(16), `${filed.caseId}x`]) {
      expect((await t.deleteCase(id, filed.plaintiffToken)).status, id).toBe(404);
    }
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 1 });
  });

  it('two simultaneous deletes (both parties) give one 200 and one 404', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const results = await Promise.all([
      t.deleteCase(filed.caseId, filed.plaintiffToken),
      t.deleteCase(filed.caseId, filed.summonsToken),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
  });
});

describe('the plaintiff token', () => {
  it('is returned once by POST /cases, distinct from the other tokens, and stored', async () => {
    const t = db.setup();
    const res = await t.post('/cases', { charge: CHARGE, testimony: PLAINTIFF });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.plaintiffToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(new Set([body.caseId, body.summonsToken, body.juryToken, body.plaintiffToken]).size).toBe(4);
    expect(body.plaintiffUrl).toBe(`http://localhost/plaintiff/${body.plaintiffToken}`);
    const [row] = await db.sql('SELECT plaintiff_token FROM cases WHERE id = $1', [body.caseId]);
    expect(row.plaintiff_token).toBe(body.plaintiffToken);
  });

  it('never appears on the case, jury or summons page', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    for (const path of [`/cases/${filed.caseId}`, `/jury/${filed.juryToken}`, `/summons/${filed.summonsToken}`]) {
      expect(await (await t.get(path)).text(), path).not.toContain(filed.plaintiffToken);
    }
  });
});

describe('the plaintiff page', () => {
  it('shows the summons, jury and case links again, the deletion date and a delete form', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: TITLE });
    t.advance(2 * HOUR);
    const res = await t.get(`/plaintiff/${filed.plaintiffToken}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(TITLE);
    expect(page).toContain(filed.summonsUrl);
    expect(page).toContain(filed.juryUrl);
    expect(page).toContain(`href="/cases/${filed.caseId}"`);
    expect(page).toMatch(/22 hours/);
    expect(page).toContain('2026-12-01');
    expect(page).toContain(`data-api="/cases/${filed.caseId}"`);
    expect(page).toContain('data-method="DELETE"');
    expect(page).toContain(`data-token="${filed.plaintiffToken}"`);
    expect(page).toContain('data-confirm=');
    expect(page).toMatch(/don't share/i);
  });

  it('follows the case through answered, ruled and declined', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    expect(await (await t.get(`/plaintiff/${filed.plaintiffToken}`)).text()).toMatch(/defendant has answered/i);

    const ruled = db.setup();
    const done = await ruled.ruledCase();
    expect(await (await ruled.get(`/plaintiff/${done.plaintiffToken}`)).text()).toMatch(/Verdict: Split decision/);

    const declining = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const refused = await declining.fileCase();
    await declining.answer(refused.summonsToken);
    await declining.post(`/cases/${refused.caseId}/rule`);
    const page = await (await declining.get(`/plaintiff/${refused.plaintiffToken}`)).text();
    expect(page).toMatch(/declined/i);
    expect(page).not.toContain(refused.juryUrl);
    expect(page).toContain('data-method="DELETE"');
  });

  it('escapes the title', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: '<script>alert(1)</script>' });
    const page = await (await t.get(`/plaintiff/${filed.plaintiffToken}`)).text();
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is 404 for a wrong token, the summons token, the jury token and a malformed one', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: TITLE });
    for (const token of [nearMiss(filed.plaintiffToken), filed.summonsToken, filed.juryToken, filed.caseId, 'nope']) {
      const res = await t.get(`/plaintiff/${token}`);
      expect(res.status, token).toBe(404);
      expect(await res.text()).not.toContain(TITLE);
    }
    // And the plaintiff token opens neither the summons nor the jury page.
    expect((await t.get(`/summons/${filed.plaintiffToken}`)).status).toBe(404);
    expect((await t.get(`/jury/${filed.plaintiffToken}`)).status).toBe(404);
  });

  it('the filing receipt has a plaintiff-link field and says to keep it private', async () => {
    const t = db.setup();
    const page = await (await t.get('/')).text();
    expect(page).toContain('data-field="plaintiffUrl"');
    expect(page).toMatch(/plaintiff link/i);
  });
});

describe('the summons page offers the defendant a delete form', () => {
  it('in every state, with the summons token as the credential', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const states = [];
    states.push(await (await t.get(`/summons/${filed.summonsToken}`)).text());
    await t.answer(filed.summonsToken);
    states.push(await (await t.get(`/summons/${filed.summonsToken}`)).text());
    await t.post(`/cases/${filed.caseId}/rule`);
    states.push(await (await t.get(`/summons/${filed.summonsToken}`)).text());
    for (const page of states) {
      expect(page).toContain(`data-api="/cases/${filed.caseId}"`);
      expect(page).toContain('data-method="DELETE"');
      expect(page).toContain(`data-token="${filed.summonsToken}"`);
    }
  });
});

describe('after deletion', () => {
  it('/deleted confirms it', async () => {
    const t = db.setup();
    const res = await t.get('/deleted');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/case is deleted/i);
  });
});
