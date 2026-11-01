import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORT_REASONS } from '../src/store.js';
import { newDevice, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const TITLE = 'The Case of the Borrowed Hoodie';
const CHARGE = 'Wore my hoodie to three parties and posted photos';
const PLAINTIFF = 'It has not been returned in six weeks.';
const DEFENDANT = 'Possession is nine tenths of fashion.';

const reportsFor = (caseId) =>
  db.sql('SELECT case_id, reason, note, created_at FROM reports WHERE case_id = $1 ORDER BY id', [caseId]);

async function caseFor(t) {
  const filed = await t.fileCase({ title: TITLE, charge: CHARGE, testimony: PLAINTIFF });
  await t.answer(filed.summonsToken, DEFENDANT);
  return filed;
}

function expectNoContent(page, where) {
  for (const text of [TITLE, CHARGE, PLAINTIFF, DEFENDANT]) expect(page, `${where} shows "${text}"`).not.toContain(text);
}

describe('reporting a case', () => {
  it('stores one report with the reason and note, and takes the case down at once', async () => {
    const t = db.setup();
    const filed = await caseFor(t);
    const res = await t.report(filed.caseId, { reason: 'names_someone', note: '  It names my flatmate, who is not in it. ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ caseId: filed.caseId, reported: true });

    const rows = await reportsFor(filed.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'names_someone', note: 'It names my flatmate, who is not in it.' });
    expect(rows[0].created_at.getTime()).toBe(t.clock.now.getTime());
    const [row] = await db.sql('SELECT reported_at FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.reported_at.getTime()).toBe(t.clock.now.getTime());
  });

  it.each(REPORT_REASONS.map((reason) => [reason]))('accepts the reason %s without a note', async (reason) => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.report(filed.caseId, { reason })).status).toBe(201);
    expect(await reportsFor(filed.caseId)).toEqual([expect.objectContaining({ reason, note: null })]);
  });

  it('knows the reasons the form offers', () => {
    expect(REPORT_REASONS).toEqual(['names_someone', 'serious', 'mean', 'other']);
  });

  it.each([
    ['no reason', {}],
    ['an unknown reason', { reason: 'boring' }],
    ['a non-string reason', { reason: ['other'] }],
    ['a note over 500 characters', { reason: 'other', note: 'x'.repeat(501) }],
    ['a non-string note', { reason: 'other', note: 42 }],
  ])('rejects %s with 400 and leaves the case up', async (_name, body) => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.report(filed.caseId, body)).status).toBe(400);
    expect(await reportsFor(filed.caseId)).toHaveLength(0);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
  });

  it('needs JSON (415), and a missing, malformed or absent case id is 404', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const form = await t.request('/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `caseId=${filed.caseId}&reason=other`,
    });
    expect(form.status).toBe(415);
    expect((await t.report('x'.repeat(16))).status).toBe(404);
    expect((await t.report('nope')).status).toBe(404);
    expect((await t.post('/reports', { reason: 'other' })).status).toBe(404);
    expect((await t.post('/reports', { caseId: [filed.caseId], reason: 'other' })).status).toBe(404);
    expect(await reportsFor(filed.caseId)).toHaveLength(0);
  });

  it('a second report on a case that is already down is 200 and stores nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await t.report(filed.caseId, { reason: 'mean' })).status).toBe(201);
    const again = await t.report(filed.caseId, { reason: 'other', note: 'me too' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ caseId: filed.caseId, reported: true });
    expect(await reportsFor(filed.caseId)).toEqual([expect.objectContaining({ reason: 'mean' })]);
  });

  it('two simultaneous reports store exactly one', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const results = await Promise.all([t.report(filed.caseId), t.report(filed.caseId, { reason: 'serious' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await reportsFor(filed.caseId)).toHaveLength(1);
  });

  it('declined cases can be reported too, because their page still shows the testimonies', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const filed = await caseFor(t);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('data-api="/reports"');
    expect(page).toContain(`name="caseId" value="${filed.caseId}"`);
    expect((await t.report(filed.caseId)).status).toBe(201);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(410);
  });
});

describe('a taken-down case', () => {
  it('shows no content on the case and jury pages (410) and has no card (404)', async () => {
    const t = db.setup();
    const filed = await caseFor(t);
    await t.post(`/cases/${filed.caseId}/rule`);
    await t.vote(filed.juryToken, { vote: 'guilty', comment: 'Return the hoodie.' }, newDevice());
    expect((await t.report(filed.caseId)).status).toBe(201);

    for (const path of [`/cases/${filed.caseId}`, `/jury/${filed.juryToken}`]) {
      const res = await t.get(path);
      expect(res.status, path).toBe(410);
      const page = await res.text();
      expect(page).toMatch(/taken down/i);
      expectNoContent(page, path);
      expect(page).not.toContain('Return the hoodie.');
      expect(page).not.toContain('og:image');
      expect(page).not.toContain('data-method="DELETE"');
    }
    expect((await t.get(`/cases/${filed.caseId}/card.png`)).status).toBe(404);
  });

  it('shows the parties only the notice and the delete form', async () => {
    const t = db.setup();
    const filed = await caseFor(t);
    await t.report(filed.caseId);
    for (const [path, token] of [
      [`/summons/${filed.summonsToken}`, filed.summonsToken],
      [`/plaintiff/${filed.plaintiffToken}`, filed.plaintiffToken],
    ]) {
      const res = await t.get(path);
      expect(res.status, path).toBe(200);
      const page = await res.text();
      expect(page).toMatch(/taken down/i);
      expectNoContent(page, path);
      expect(page).toContain('data-method="DELETE"');
      expect(page).toContain(`data-token="${token}"`);
      expect(page).not.toContain(filed.juryToken);
      expect(page).not.toContain('name="testimony"');
    }
  });

  it('closes testimony, votes, the judge and the unlock (409), but delete still works', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: TITLE });
    await t.report(filed.caseId);

    const writes = [
      ['testimony', t.answer(filed.summonsToken)],
      ['vote', t.vote(filed.juryToken, { vote: 'guilty' }, newDevice())],
      ['rule', t.post(`/cases/${filed.caseId}/rule`)],
      ['unlock', t.unlock(filed.caseId)],
    ];
    for (const [name, pending] of writes) {
      const res = await pending;
      expect(res.status, name).toBe(409);
      expect((await res.json()).error, name).toMatch(/taken down/i);
    }
    const [row] = await db.sql('SELECT defendant_testimony, ruling FROM cases WHERE id = $1', [filed.caseId]);
    expect(row).toEqual({ defendant_testimony: null, ruling: null });
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ votes: 0, unlock_clicks: 0 });
    expect(t.judge).not.toHaveBeenCalled();

    expect((await t.deleteCase(filed.caseId, filed.plaintiffToken)).status).toBe(200);
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
  });

  it('a ruled case no longer hands out its ruling from /rule', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    await t.report(filed.caseId);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/adjourned/i);
  });

  it('a report that lands mid-deliberation stops the ruling being stored', async () => {
    const t = db.setup({
      judge: async () => {
        await t.report(filed.caseId);
        return JSON.stringify({ verdict: 'guilty', ruling: 'Order. '.repeat(50).trim() });
      },
    });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(409);
    const [row] = await db.sql('SELECT ruling FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.ruling).toBeNull();
  });
});

describe('the report form', () => {
  it('is on the case, jury and summons pages, with every reason', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const path of [`/cases/${filed.caseId}`, `/jury/${filed.juryToken}`, `/summons/${filed.summonsToken}`]) {
      const page = await (await t.get(path)).text();
      expect(page, path).toContain('<summary>Report this case</summary>');
      expect(page, path).toContain('data-api="/reports"');
      expect(page, path).toContain(`<input type="hidden" name="caseId" value="${filed.caseId}">`);
      for (const reason of REPORT_REASONS) expect(page, `${path} ${reason}`).toContain(`value="${reason}"`);
      expect(page, path).toContain('name="note"');
    }
  });

  it('is not on the plaintiff page (the plaintiff can delete instead)', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect(await (await t.get(`/plaintiff/${filed.plaintiffToken}`)).text()).not.toContain('data-api="/reports"');
  });
});
