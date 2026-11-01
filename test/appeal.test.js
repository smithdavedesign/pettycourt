// M4: the appeal itself, once it's paid for: who may file it, what the judge hears, what happens when
// the judge is down or declines, and how the pages and the card show the result.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardElement, cardModel, renderCardPng } from '../src/card.js';
import { APPEAL_PROMPT, SYSTEM_PROMPT, buildMessages } from '../src/judge.js';
import { APPEAL_RULING, DAY, GOOD_RULING, NEW_EVIDENCE, judgeReply, nearMiss, newDevice, pngSize, testDatabase } from './helpers.js';
import { paidMode } from './stripe.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
afterEach(() => vi.restoreAllMocks());

const XSS = '<script>alert("pwned")</script>';
const appealJudge = async (caseFile) => (caseFile.appeal ? judgeReply('not_guilty', APPEAL_RULING) : judgeReply());
const appealOf = async (caseId) =>
  (
    await db.sql(
      `SELECT appeal_click_id, appeal_side, appeal_evidence, appealed_at, appeal_verdict, appeal_ruling, appeal_ruled_at,
              appeal_declined_at FROM cases WHERE id = $1`,
      [caseId],
    )
  )[0];
const NOTHING_FILED = { appealed_at: null, appeal_evidence: null, appeal_side: null, appeal_ruling: null };
const caseText = async (t, caseId) => (await t.get(`/cases/${caseId}`)).text();

describe('who may file the appeal', () => {
  it('needs the payer’s click id as a bearer token: 401 without one', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    for (const headers of [{}, { authorization: `Basic ${filed.clickId}` }, { authorization: 'Bearer' }]) {
      const res = await t.post(`/cases/${filed.caseId}/appeal`, { side: 'defendant', evidence: NEW_EVIDENCE }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      if (!headers.authorization) expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(await appealOf(filed.caseId)).toMatchObject(NOTHING_FILED);
  });

  it('refuses anyone but a payer of this case with 403', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const other = await t.paidCase();
    const ruled = await t.ruledCase();
    // Two people open Checkout; only the first pays.
    const payer = await t.startCheckout(ruled.caseId);
    const { clickId: unpaid } = await t.startCheckout(ruled.caseId);
    t.stripe.pay(payer.session.id);
    expect((await t.deliver('checkout.session.completed', payer.session.id)).status).toBe(200);
    const filed = { ...ruled, clickId: payer.clickId };
    const { clickId: fakeDoor } = await (await t.unlock(filed.caseId)).json();
    const tokens = {
      'another case’s paid click': other.clickId,
      'an unpaid click on this case': unpaid,
      'a near miss': nearMiss(filed.clickId),
      'the plaintiff token': filed.plaintiffToken,
      'the summons token': filed.summonsToken,
      'the jury token': filed.juryToken,
      'a fake-door click': fakeDoor,
      'a malformed token': 'short',
    };
    for (const [name, token] of Object.entries(tokens)) {
      const res = await t.appeal(filed.caseId, token);
      expect(res.status, name).toBe(403);
      expect((await res.json()).error, name).toMatch(/paid/i);
    }
    expect(await appealOf(filed.caseId)).toMatchObject(NOTHING_FILED);
    // And the rightful payer still can.
    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(201);
  });

  it('the appellant chooses a side, and the judge is told which', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    t.judge.mockClear();
    expect((await t.appeal(filed.caseId, filed.clickId, { side: 'plaintiff', evidence: 'The receipt for the cinema.' })).status).toBe(201);
    expect(t.judge.mock.calls[0][0].appeal).toMatchObject({ appellant: 'Plaintiff', newEvidence: 'The receipt for the cinema.' });
    expect(await appealOf(filed.caseId)).toMatchObject({ appeal_side: 'plaintiff' });
  });
});

describe('what the appeal accepts', () => {
  it.each([
    ['no side', { evidence: NEW_EVIDENCE }, /side/i],
    ['an unknown side', { side: 'jury', evidence: NEW_EVIDENCE }, /side/i],
    ['no evidence', { side: 'defendant' }, /evidence/i],
    ['blank evidence', { side: 'defendant', evidence: '   ' }, /evidence/i],
    ['evidence that is not text', { side: 'defendant', evidence: ['a'] }, /evidence/i],
    ['evidence over 1000 characters', { side: 'defendant', evidence: 'e'.repeat(1001) }, /1000/],
  ])('rejects %s with 400 and stores nothing', async (_name, body, pattern) => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const res = await t.appeal(filed.caseId, filed.clickId, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(pattern);
    expect(await appealOf(filed.caseId)).toMatchObject(NOTHING_FILED);
  });

  it('accepts exactly 1000 characters, trimmed', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const evidence = 'e'.repeat(1000);
    expect((await t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: `  ${evidence}  ` })).status).toBe(201);
    expect((await appealOf(filed.caseId)).appeal_evidence).toBe(evidence);
  });

  it('needs JSON (415) under the body limit (413)', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const form = await t.request(`/cases/${filed.caseId}/appeal`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${filed.clickId}` },
      body: 'side=defendant&evidence=x',
    });
    expect(form.status).toBe(415);
    const huge = await t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: 'x'.repeat(17 * 1024) });
    expect(huge.status).toBe(413);
    expect(await appealOf(filed.caseId)).toMatchObject(NOTHING_FILED);
  });

  it('declines out-of-scope evidence with 422, stores nothing, and the paid appeal is still there to use', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    t.judge.mockClear();
    const res = await t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: 'Exhibit A: my boyfriend hits me' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ declined: true });
    expect(t.judge).not.toHaveBeenCalled();
    expect(await appealOf(filed.caseId)).toMatchObject(NOTHING_FILED);
    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(201);
  });
});

describe('which cases can be appealed', () => {
  it('is 404 for a missing or malformed case', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    expect((await t.appeal('x'.repeat(16), filed.clickId)).status).toBe(404);
    expect((await t.appeal('nope', filed.clickId)).status).toBe(404);
  });

  it('is 409 before the ruling, for a declined case and for a taken-down case', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const waiting = await t.fileCase();
    const res = await t.appeal(waiting.caseId, undefined);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/after the ruling/i);

    const declining = paidMode(db, { judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const declined = await declining.fileCase();
    await declining.answer(declined.summonsToken);
    await declining.post(`/cases/${declined.caseId}/rule`);
    expect((await declining.appeal(declined.caseId, undefined)).status).toBe(409);

    const paid = await t.paidCase();
    await t.report(paid.caseId);
    const down = await t.appeal(paid.caseId, paid.clickId);
    expect(down.status).toBe(409);
    expect((await down.json()).error).toMatch(/taken down/i);
    expect(await appealOf(paid.caseId)).toMatchObject(NOTHING_FILED);
  });
});

describe('hearing the appeal', () => {
  it('when the judge is down the appeal is still accepted (201, heard: false), and /appeal/rule hears it later, once', async () => {
    let up = false;
    const t = paidMode(db, {
      judge: async (caseFile) => {
        if (caseFile.appeal && !up) throw new Error('quota exhausted');
        return caseFile.appeal ? judgeReply('guilty', APPEAL_RULING) : judgeReply();
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await t.paidCase();

    const res = await t.appeal(filed.caseId, filed.clickId);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ heard: false, appeal: { side: 'defendant', evidence: NEW_EVIDENCE, verdict: null, ruling: null } });
    expect(body.error).toMatch(/try again/i);
    expect(await appealOf(filed.caseId)).toMatchObject({ appeal_evidence: NEW_EVIDENCE, appeal_ruling: null });
    // A second filing is still refused: the appeal exists, it just hasn't been heard.
    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(409);

    // The case page offers to hear it.
    expect(await caseText(t, filed.caseId)).toContain(`data-api="/cases/${filed.caseId}/appeal/rule"`);
    expect((await t.hearAppeal(filed.caseId)).status).toBe(502);

    up = true;
    t.judge.mockClear();
    const heard = await t.hearAppeal(filed.caseId);
    expect(heard.status).toBe(200);
    const result = await heard.json();
    expect(result).toMatchObject({ caseId: filed.caseId, appeal: { verdict: 'guilty', ruling: APPEAL_RULING, outcome: 'overturned' } });
    expect(t.judge).toHaveBeenCalledTimes(1);

    // Idempotent: no second model call, same answer.
    const again = await t.hearAppeal(filed.caseId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(result);
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect(await caseText(t, filed.caseId)).not.toContain('/appeal/rule');
  });

  it('a malformed judge reply stores no appeal ruling (502 on retry), and an unconfigured judge is 503', async () => {
    const replies = ['not json', JSON.stringify({ verdict: 'acquitted', ruling: APPEAL_RULING }), judgeReply('guilty', 'Too short.')];
    const t = paidMode(db, { judge: async (caseFile) => (caseFile.appeal ? replies.shift() ?? 'nope' : judgeReply()) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await t.paidCase();
    expect(await (await t.appeal(filed.caseId, filed.clickId)).json()).toMatchObject({ heard: false });
    expect((await t.hearAppeal(filed.caseId)).status).toBe(502);
    expect((await t.hearAppeal(filed.caseId)).status).toBe(502);
    expect(await appealOf(filed.caseId)).toMatchObject({ appeal_ruling: null, appeal_verdict: null, appeal_ruled_at: null });

    const unconfigured = paidMode(db, {
      judge: async (caseFile) => {
        if (!caseFile.appeal) return judgeReply();
        throw Object.assign(new Error('not configured'), { code: 'JUDGE_NOT_CONFIGURED' });
      },
    });
    const other = await unconfigured.paidCase();
    await unconfigured.appeal(other.caseId, other.clickId);
    expect((await unconfigured.hearAppeal(other.caseId)).status).toBe(503);
  });

  it('when the model declines the appeal, the original ruling stands and the evidence stays off public pages', async () => {
    const t = paidMode(db, {
      judge: async (caseFile) => (caseFile.appeal ? JSON.stringify({ verdict: 'declined', ruling: '' }) : judgeReply()),
    });
    const filed = await t.paidCase();
    const res = await t.appeal(filed.caseId, filed.clickId, { side: 'defendant', evidence: 'Secret exhibit nobody should see.' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ heard: true, appeal: { declined: true, verdict: null, evidence: null } });
    expect((await appealOf(filed.caseId)).appeal_declined_at).not.toBeNull();

    expect((await t.hearAppeal(filed.caseId)).status).toBe(422);
    const page = await caseText(t, filed.caseId);
    expect(page).toMatch(/declines to hear the appeal/i);
    expect(page).toContain('Verdict: Split decision');
    expect(page).not.toContain('Secret exhibit');
    expect(await (await t.get(`/jury/${filed.juryToken}`)).text()).not.toContain('Secret exhibit');
    const found = await db.store.getCase(filed.caseId);
    expect(cardModel(found, await db.store.getJury(filed.caseId), 'x')).toMatchObject({ verdict: 'Split decision', appeal: null });
  });

  it('re-screens the whole file before the hearing and declines without calling the model', async () => {
    const t = paidMode(db, { judge: appealJudge });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await t.paidCase();
    // An appeal stored before a term joined the list: written straight to the database.
    await db.sql(
      `UPDATE cases SET appeal_click_id = $2, appeal_side = 'defendant', appeal_evidence = 'Exhibit A: my boyfriend hits me',
       appealed_at = now() WHERE id = $1`,
      [filed.caseId, filed.clickId],
    );
    t.judge.mockClear();
    const res = await t.hearAppeal(filed.caseId);
    expect(res.status).toBe(422);
    expect(t.judge).not.toHaveBeenCalled();
    expect((await appealOf(filed.caseId)).appeal_declined_at).not.toBeNull();
  });

  it('is 409 with no appeal filed, 404 for a missing case', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const res = await t.hearAppeal(filed.caseId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no appeal/i);
    expect((await t.hearAppeal('x'.repeat(16))).status).toBe(404);
  });

  it('a report landing mid-hearing stores no appeal ruling (409); a delete mid-hearing answers 404', async () => {
    let during = async () => {};
    const t = paidMode(db, {
      judge: async (caseFile) => {
        if (!caseFile.appeal) return judgeReply();
        await during();
        return judgeReply('guilty', APPEAL_RULING);
      },
    });
    const reported = await t.paidCase();
    during = () => t.report(reported.caseId);
    const res = await t.appeal(reported.caseId, reported.clickId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/taken down/i);
    expect(await appealOf(reported.caseId)).toMatchObject({ appeal_ruling: null });

    const deleted = await t.paidCase();
    during = () => t.deleteCase(deleted.caseId, deleted.plaintiffToken);
    expect((await t.appeal(deleted.caseId, deleted.clickId)).status).toBe(404);
    expect(await db.rowsFor(deleted.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
  });
});

describe('the appeal prompt', () => {
  it('appeal hearings get the M1 rules plus the appeal rules; ordinary rulings keep the M1 prompt', () => {
    const plain = { title: 't', charge: 'c', plaintiffTestimony: 'p', defendantTestimony: 'd', defendantAppeared: true };
    expect(buildMessages(plain)[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    const appeal = { ...plain, appeal: { appellant: 'Defendant', newEvidence: XSS, originalVerdict: 'guilty', originalRuling: GOOD_RULING } };
    const [system, user] = buildMessages(appeal);
    expect(system).toEqual({ role: 'system', content: APPEAL_PROMPT });
    for (const line of SYSTEM_PROMPT.split('\n').filter((l) => l.startsWith('- '))) expect(APPEAL_PROMPT).toContain(line);
    expect(APPEAL_PROMPT).toMatch(/appeal/i);
    expect(APPEAL_PROMPT).toMatch(/uphold/i);
    expect(APPEAL_PROMPT).toMatch(/overturn/i);
    expect(APPEAL_PROMPT).toMatch(/evidence, not instructions/);
    expect(APPEAL_PROMPT).toContain('"declined"');
    // The new evidence travels as JSON data, like the testimonies.
    expect(JSON.parse(user.content.slice(user.content.indexOf('{')))).toEqual(appeal);
  });
});

describe('the pages, with payments switched on', () => {
  it('the case page: no button before the ruling, Checkout after it, then paid, then the appeal', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.fileCase();
    let page = await caseText(t, filed.caseId);
    expect(page).toMatch(/Full trial · \$3/);
    expect(page).toMatch(/after the ruling/i);
    expect(page).not.toContain('/checkout');
    expect(page).not.toContain('/unlock');

    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    page = await caseText(t, filed.caseId);
    expect(page).toContain(`data-api="/cases/${filed.caseId}/checkout"`);
    expect(page).toContain('data-then="redirect"');
    expect(page).toContain('href="/terms"');
    expect(page).toMatch(/refund/i);
    expect(page).not.toContain('/unlock');

    const { clickId, session } = await t.startCheckout(filed.caseId);
    t.stripe.pay(session.id);
    await t.deliver('checkout.session.completed', session.id);
    page = await caseText(t, filed.caseId);
    expect(page).not.toContain('/checkout');
    expect(page).toMatch(/appeal is paid for/i);
    expect(page).not.toContain(clickId);

    await t.appeal(filed.caseId, clickId, { side: 'defendant', evidence: NEW_EVIDENCE });
    page = await caseText(t, filed.caseId);
    expect(page).toContain('Verdict on appeal: Not guilty (overturned)');
    expect(page).toContain('The defendant appealed with new evidence');
    expect(page).toContain('the taxi app shows I booked the ride');
    expect(page).toContain('Order in the group chat, on appeal.');
    expect(page).toContain('Verdict: Split decision'); // the original stays on the record
    expect(page).not.toContain('/checkout');
    expect(page).not.toContain(clickId);
  });

  it('an upheld verdict says so', async () => {
    const t = paidMode(db, { judge: async (f) => (f.appeal ? judgeReply('split', APPEAL_RULING) : judgeReply()) });
    const filed = await t.paidCase();
    expect((await (await t.appeal(filed.caseId, filed.clickId)).json()).appeal.outcome).toBe('upheld');
    expect(await caseText(t, filed.caseId)).toContain('Verdict on appeal: Split decision (upheld)');
  });

  it('the jury page and the plaintiff page show the outcome, with no buttons', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    const jury = await (await t.juryPage(filed.juryToken, newDevice())).text();
    expect(jury).toContain('Verdict on appeal: Not guilty (overturned)');
    expect(jury).not.toContain('/appeal/rule');
    const desk = await (await t.get(`/plaintiff/${filed.plaintiffToken}`)).text();
    expect(desk).toMatch(/On appeal: Not guilty/);
  });

  it('escapes HTML in the evidence and the appeal ruling', async () => {
    const ruling = `${APPEAL_RULING} ${XSS}`;
    const t = paidMode(db, { judge: async (f) => (f.appeal ? judgeReply('guilty', ruling) : judgeReply()) });
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId, { side: 'plaintiff', evidence: `Exhibit ${XSS}` });
    for (const path of [`/cases/${filed.caseId}`, `/appeals/${filed.clickId}`, `/jury/${filed.juryToken}`]) {
      const page = await (await t.get(path)).text();
      expect(page, path).not.toContain('<script>alert');
      expect(page, path).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');
    }
  });

  it('the fake door (payments off) now promises only the appeal M4 sells', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const page = await caseText(t, filed.caseId);
    expect(page).toMatch(/one appeal with new evidence/i);
    expect(page).not.toMatch(/photo/i);
  });
});

describe('the verdict card after an appeal', () => {
  it('shows the verdict on appeal, whether it was upheld or overturned, and the appeal ruling', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    const before = cardModel(await db.store.getCase(filed.caseId), await db.store.getJury(filed.caseId), 'x');
    expect(before).toMatchObject({ verdict: 'Split decision', appeal: null });

    await t.appeal(filed.caseId, filed.clickId);
    const found = await db.store.getCase(filed.caseId);
    const model = cardModel(found, await db.store.getJury(filed.caseId), 'x');
    expect(model).toMatchObject({ verdict: 'Not guilty', appeal: 'Overturned on appeal', ruled: true });
    expect(model.ruling.startsWith('Order in the group chat, on appeal.')).toBe(true);
    expect(cardModel({ ...found, appealVerdict: 'split' }, { guilty: 0, notGuilty: 0, total: 0 }, 'x').appeal).toBe('Upheld on appeal');

    expect(JSON.stringify(cardElement(model))).toContain('OVERTURNED ON APPEAL');

    const res = await t.get(`/cases/${filed.caseId}/card.png`);
    expect(res.status).toBe(200);
    expect(pngSize(new Uint8Array(await res.arrayBuffer()))).toEqual({ width: 1080, height: 1350 });
  });

  it('renders 1080×1350 with a 300-character title, the longest verdict and a 200-word appeal ruling', async () => {
    const model = cardModel(
      {
        title: 'T'.repeat(150) + ' ' + 'title '.repeat(25),
        charge: 'c'.repeat(280),
        verdict: 'guilty',
        ruling: GOOD_RULING,
        ruledAt: new Date(),
        appealVerdict: 'split',
        appealRuling: 'objection '.repeat(200).trim(),
        appealRuledAt: new Date(),
      },
      { guilty: 99, notGuilty: 99, total: 198 },
      'pettycourt.onrender.com',
    );
    expect(model.appeal).toBe('Overturned on appeal');
    expect(JSON.stringify(cardElement(model))).toContain('OVERTURNED ON APPEAL');
    expect(pngSize(await renderCardPng(model))).toEqual({ width: 1080, height: 1350 });
  });
});

describe('deletion and expiry take the appeal and the payment with them', () => {
  it('a party delete removes the payment clicks and the appeal', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    expect((await t.deleteCase(filed.caseId, filed.summonsToken)).status).toBe(200);
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    expect(await db.sql('SELECT 1 FROM unlock_clicks WHERE checkout_session_id = $1', [filed.session.id])).toHaveLength(0);
    for (const path of [`/appeals/${filed.clickId}`, `/cases/${filed.caseId}`]) expect((await t.get(path)).status, path).toBe(404);
    expect((await t.appeal(filed.caseId, filed.clickId)).status).toBe(404);
    expect((await t.hearAppeal(filed.caseId)).status).toBe(404);
  });

  it('the 30-day expiry removes a paid, appealed case like any other', async () => {
    const t = paidMode(db, { judge: appealJudge });
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    t.advance(30 * DAY + 1);
    expect((await t.expire()).status).toBe(200);
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
    expect((await t.get(`/appeals/${filed.clickId}`)).status).toBe(404);
  });
});
