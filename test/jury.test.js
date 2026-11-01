import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardModel } from '../src/card.js';
import { DECLINE_MESSAGE } from '../src/scope.js';
import { HOUR, judgeReply, newDevice, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const SECRET_TITLE = 'The Great Remote Control Standoff';
const SECRET_CHARGE = 'Hid the TV remote inside the fruit bowl';
const SECRET_TESTIMONY = 'I searched for an hour and found it under the bananas.';

async function fileSecretCase(t) {
  return t.fileCase({ title: SECRET_TITLE, charge: SECRET_CHARGE, testimony: SECRET_TESTIMONY });
}

/** Flip one character so the token has the right shape but matches nothing. */
function nearMiss(token) {
  const last = token.at(-1);
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

async function voteRows(caseId) {
  return db.sql('SELECT voter, vote, comment FROM votes WHERE case_id = $1 ORDER BY created_at, voter', [caseId]);
}

function setCookieOf(res) {
  return res.headers.get('set-cookie') ?? '';
}

function deviceFrom(res) {
  return setCookieOf(res).match(/pc_device=([^;]+)/)?.[1];
}

describe('M2 exit criterion: three devices give a matching split; a repeat vote returns 409', () => {
  it('three votes from three distinct device ids give a 2–1 split, and a repeat from the first device returns 409', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const [alice, bob, carol] = [newDevice(), newDevice(), newDevice()];

    const first = await t.vote(filed.juryToken, { vote: 'guilty' }, alice);
    expect(first.status).toBe(201);
    expect((await first.json()).jury).toEqual({ guilty: 1, notGuilty: 0, total: 1 });

    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: 'Classic shower lie.' }, bob)).status).toBe(201);

    const third = await t.vote(filed.juryToken, { vote: 'not_guilty', comment: 'Showers count as travel.' }, carol);
    expect(third.status).toBe(201);
    const body = await third.json();
    expect(body).toMatchObject({ caseId: filed.caseId, vote: 'not_guilty', caseUrl: filed.caseUrl });
    expect(body.jury).toEqual({ guilty: 2, notGuilty: 1, total: 3 });

    // Alice tries again, switching sides: rejected, and her first vote stands.
    const repeat = await t.vote(filed.juryToken, { vote: 'not_guilty' }, alice);
    expect(repeat.status).toBe(409);
    const repeated = await repeat.json();
    expect(repeated.error).toMatch(/already voted/i);
    expect(repeated.jury).toEqual({ guilty: 2, notGuilty: 1, total: 3 });

    // Had the repeat overwritten Alice's vote, this would be one guilty and two not guilty.
    const rows = await voteRows(filed.caseId);
    expect(rows.map((r) => r.vote).sort()).toEqual(['guilty', 'guilty', 'not_guilty']);

    // The same split on the results page, the jury page and the card.
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('2 guilty · 1 not guilty');
    expect(page).toContain('Classic shower lie.');
    expect(page).toContain('Showers count as travel.');

    const juryPage = await (await t.juryPage(filed.juryToken, alice)).text();
    expect(juryPage).toContain('2 guilty · 1 not guilty');

    const found = await db.store.getCase(filed.caseId);
    const jury = await db.store.getJury(filed.caseId);
    expect(cardModel(found, jury, 'localhost').jury).toBe('2 guilty · 1 not guilty');
  });

  it('a repeat vote is rejected for every vote value and comment', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const device = newDevice();
    expect((await t.vote(filed.juryToken, { vote: 'not_guilty' }, device)).status).toBe(201);
    for (const again of [{ vote: 'not_guilty' }, { vote: 'guilty' }, { vote: 'guilty', comment: 'changed my mind' }]) {
      expect((await t.vote(filed.juryToken, again, device)).status).toBe(409);
    }
    expect(await voteRows(filed.caseId)).toEqual([expect.objectContaining({ vote: 'not_guilty', comment: null })]);
  });

  it('two simultaneous votes from the same device store exactly one', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const device = newDevice();
    const results = await Promise.all([
      t.vote(filed.juryToken, { vote: 'guilty' }, device),
      t.vote(filed.juryToken, { vote: 'not_guilty' }, device),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await voteRows(filed.caseId)).toHaveLength(1);
  });
});

describe('device cookie', () => {
  it('a first vote without a cookie issues one; voting again with it returns 409', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.vote(filed.juryToken, { vote: 'guilty' });
    expect(res.status).toBe(201);

    const cookie = setCookieOf(res);
    expect(cookie).toMatch(/^pc_device=[A-Za-z0-9_-]{32};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/jury/);
    expect(cookie).toMatch(/Max-Age=\d+/);

    expect((await t.vote(filed.juryToken, { vote: 'guilty' }, deviceFrom(res))).status).toBe(409);
  });

  it('marks the cookie Secure over https', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.request(`https://pettycourt.example/jury/${filed.juryToken}/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vote: 'guilty' }),
    });
    expect(res.status).toBe(201);
    expect(setCookieOf(res)).toMatch(/Secure/);
  });

  it('a known device keeps its cookie (no new Set-Cookie)', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.vote(filed.juryToken, { vote: 'guilty' }, newDevice());
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('replaces a malformed or forged cookie with a fresh device id', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const forged of ['short', 'x'.repeat(200), 'not/base64url=!!!!!!!!!!!!!!!!!!!!!!!']) {
      const res = await t.vote(filed.juryToken, { vote: 'guilty' }, forged);
      expect(res.status).toBe(201);
      const issued = deviceFrom(res);
      expect(issued).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(issued).not.toBe(forged);
    }
    expect(await voteRows(filed.caseId)).toHaveLength(3);
  });

  it('never stores the raw device id, and keys votes per case so devices cannot be linked across cases', async () => {
    const t = db.setup();
    const one = await t.fileCase();
    const two = await t.fileCase({ charge: 'Ate my labelled yoghurt' });
    const device = newDevice();
    expect((await t.vote(one.juryToken, { vote: 'guilty' }, device)).status).toBe(201);
    expect((await t.vote(two.juryToken, { vote: 'guilty' }, device)).status).toBe(201);

    const [a] = await voteRows(one.caseId);
    const [b] = await voteRows(two.caseId);
    expect(a.voter).not.toBe(b.voter);
    const everything = JSON.stringify(await db.sql('SELECT * FROM votes'));
    expect(everything).not.toContain(device);
  });
});

describe('POST /jury/:token/votes validation', () => {
  it('rejects a missing, unknown or non-string vote with 400 and stores nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const body of [{}, { vote: '' }, { vote: 'maybe' }, { vote: 'GUILTY' }, { vote: 1 }, { vote: ['guilty'] }, { vote: null }]) {
      const res = await t.vote(filed.juryToken, body, newDevice());
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(/vote/i);
    }
    expect(await voteRows(filed.caseId)).toEqual([]);
  });

  it('rejects a comment that is not text or longer than 140 characters', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const comment of [42, { text: 'hi' }, 'x'.repeat(141)]) {
      const res = await t.vote(filed.juryToken, { vote: 'guilty', comment }, newDevice());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/comment/i);
    }
    expect(await voteRows(filed.caseId)).toEqual([]);
  });

  it('accepts a 140-character comment, collapses it to one line, and stores a blank one as no comment', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const exact = 'y'.repeat(140);
    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: exact }, newDevice())).status).toBe(201);
    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: '  two\nlines\r\n here ' }, newDevice())).status).toBe(201);
    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: '   ' }, newDevice())).status).toBe(201);
    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: null }, newDevice())).status).toBe(201);
    const comments = (await voteRows(filed.caseId)).map((r) => r.comment);
    expect(comments).toContain(exact);
    expect(comments).toContain('two lines here');
    expect(comments.filter((c) => c === null)).toHaveLength(2);
  });

  it('answers 415 for a non-JSON body and 400 for broken JSON', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const form = await t.request(`/jury/${filed.juryToken}/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'vote=guilty',
    });
    expect(form.status).toBe(415);
    expect((await t.post(`/jury/${filed.juryToken}/votes`, '{"vote":')).status).toBe(400);
    expect((await t.post(`/jury/${filed.juryToken}/votes`, '["guilty"]')).status).toBe(400);
  });

  it('declines an out-of-scope comment with 422 and stores no vote', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.vote(filed.juryToken, { vote: 'guilty', comment: 'he owes me $500 anyway' }, newDevice());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(DECLINE_MESSAGE);
    expect(await voteRows(filed.caseId)).toEqual([]);
  });

  it('accepts petty comments the scope screen must not catch', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const comment of ['So childish.', 'Are you kidding me?', 'He hits snooze nine times, guilty.']) {
      expect((await t.vote(filed.juryToken, { vote: 'guilty', comment }, newDevice())).status).toBe(201);
    }
  });
});

describe('jury voting and the case lifecycle', () => {
  it('jurors can vote before the defendant answers and after the ruling', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.vote(filed.juryToken, { vote: 'guilty' }, newDevice())).status).toBe(201);
    await t.answer(filed.summonsToken);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
    const late = await t.vote(filed.juryToken, { vote: 'not_guilty' }, newDevice());
    expect(late.status).toBe(201);
    expect((await late.json()).jury).toEqual({ guilty: 1, notGuilty: 1, total: 2 });
  });

  it('a declined case takes no votes (409) and its jury page shows no case content', async () => {
    const t = db.setup({ judge: async () => judgeReply('declined', '') });
    const filed = await fileSecretCase(t);
    await t.answer(filed.summonsToken);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(422);

    const res = await t.vote(filed.juryToken, { vote: 'guilty' }, newDevice());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/declined/i);
    expect(await voteRows(filed.caseId)).toEqual([]);

    const page = await t.juryPage(filed.juryToken);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toMatch(/declined/i);
    expect(text).not.toContain(SECRET_CHARGE);
    expect(text).not.toContain(SECRET_TESTIMONY);
    expect(text).not.toContain('name="vote"');
  });

  it('keeps votes per case: one case’s jury does not leak into another', async () => {
    const t = db.setup();
    const one = await t.fileCase();
    const two = await t.fileCase();
    await t.vote(one.juryToken, { vote: 'guilty' }, newDevice());
    await t.vote(one.juryToken, { vote: 'guilty' }, newDevice());
    const res = await t.vote(two.juryToken, { vote: 'not_guilty' }, newDevice());
    expect((await res.json()).jury).toEqual({ guilty: 0, notGuilty: 1, total: 1 });
  });
});

describe('wrong jury tokens', () => {
  it('return 404 on the page and the vote API and leak no case content', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    const wrong = [nearMiss(filed.juryToken), filed.summonsToken, filed.caseId, 'not-a-token', 'A'.repeat(32), `${filed.juryToken}x`];
    for (const token of wrong) {
      const page = await t.get(`/jury/${encodeURIComponent(token)}`);
      expect(page.status, token).toBe(404);
      const html = await page.text();
      for (const secret of [SECRET_TITLE, SECRET_CHARGE, SECRET_TESTIMONY, filed.juryToken, filed.summonsToken]) {
        expect(html).not.toContain(secret);
      }

      const vote = await t.vote(encodeURIComponent(token), { vote: 'guilty' }, newDevice());
      expect(vote.status, token).toBe(404);
      const json = await vote.text();
      for (const secret of [SECRET_TITLE, SECRET_CHARGE, filed.caseId]) expect(json).not.toContain(secret);
    }
    expect(await voteRows(filed.caseId)).toEqual([]);
  });
});

describe('GET /jury/:token', () => {
  it('shows the case file and a vote form with a one-line comment field, but not the split before voting', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    await t.vote(filed.juryToken, { vote: 'guilty' }, newDevice());
    const res = await t.juryPage(filed.juryToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const page = await res.text();
    for (const text of [SECRET_TITLE, SECRET_CHARGE, SECRET_TESTIMONY]) expect(page).toContain(text);
    expect(page).toMatch(/waiting for the defendant/i);
    expect(page).toContain(`data-api="/jury/${filed.juryToken}/votes"`);
    expect(page).toContain('name="vote" value="guilty"');
    expect(page).toContain('name="vote" value="not_guilty"');
    expect(page).toMatch(/<input[^>]*name="comment"[^>]*maxlength="140"/);
    expect(page).not.toContain('1 guilty · 0 not guilty');
    // The jury page never hands out the summons link.
    expect(page).not.toContain(filed.summonsToken);
  });

  it('after voting, shows this device’s vote and the split instead of the form', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const device = newDevice();
    await t.vote(filed.juryToken, { vote: 'not_guilty', comment: 'Let him shower.' }, device);
    const page = await (await t.juryPage(filed.juryToken, device)).text();
    expect(page).toMatch(/your vote: not guilty/i);
    expect(page).toContain('0 guilty · 1 not guilty');
    expect(page).not.toContain('name="vote"');
    expect(page).toContain(`/cases/${filed.caseId}`);
  });

  it('shows the defendant’s answer and the judge’s ruling once there is one', async () => {
    const t = db.setup({ judge: async () => judgeReply('guilty') });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken, 'I was mentally en route.');
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.juryPage(filed.juryToken)).text();
    expect(page).toContain('I was mentally en route.');
    expect(page).toContain('Verdict: Guilty');
    expect(page).toContain('Court is adjourned.');
    expect(page).toContain('name="vote"');
  });

  it('after the deadline with no answer, says the defendant failed to appear', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(25 * HOUR);
    const page = await (await t.juryPage(filed.juryToken)).text();
    expect(page).toMatch(/failed to appear/i);
  });

  it('escapes HTML in the case file and in comments', async () => {
    const XSS = '<script>alert("pwned")</script>';
    const t = db.setup();
    const filed = await t.fileCase({ title: XSS, charge: XSS, testimony: XSS });
    const device = newDevice();
    expect((await t.vote(filed.juryToken, { vote: 'guilty', comment: XSS }, device)).status).toBe(201);
    for (const page of [await (await t.juryPage(filed.juryToken, device)).text(), await (await t.get(`/cases/${filed.caseId}`)).text()]) {
      expect(page).not.toContain('<script>alert');
      expect(page).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
    }
  });
});

describe('the jury on the results page', () => {
  it('says there are no votes yet, and never shows the jury token', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/no jury votes yet/i);
    expect(page).not.toContain(filed.juryToken);
  });

  it('lists comments with each juror’s vote, and leaves out votes without a comment', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    await t.vote(filed.juryToken, { vote: 'guilty', comment: 'Shower-based lying.' }, newDevice());
    await t.vote(filed.juryToken, { vote: 'not_guilty' }, newDevice());
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('1 guilty · 1 not guilty');
    expect(page).toMatch(/Guilty<\/strong>[^<]*Shower-based lying\./);
    expect(page.match(/<li class="comment">/g)).toHaveLength(1);
    expect(page).not.toContain(filed.juryToken);
  });

  it('does not show the jury on a declined case', async () => {
    const t = db.setup({ judge: async () => judgeReply('declined', '') });
    const filed = await t.fileCase();
    await t.vote(filed.juryToken, { vote: 'guilty', comment: 'before the decline' }, newDevice());
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('before the decline');
    expect(page).not.toMatch(/1 guilty/);
  });
});

describe('the jury link at filing', () => {
  it('POST /cases returns a jury URL next to the summons URL', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect(filed.juryUrl).toBe(`http://localhost/jury/${filed.juryToken}`);
    expect(filed.juryUrl).not.toBe(filed.summonsUrl);
  });

  it('the filing receipt on the home page has a copyable jury link', async () => {
    const t = db.setup();
    const page = await (await t.get('/')).text();
    expect(page).toContain('data-field="juryUrl"');
    expect(page).toContain('data-copy="juryUrl"');
  });

  it('the client script reloads the jury page after a vote', async () => {
    const t = db.setup();
    const js = await (await t.get('/app.js')).text();
    expect(js).toContain('"reload"');
  });
});
