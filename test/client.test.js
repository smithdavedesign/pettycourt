// The real client script (CLIENT_JS) running on the server's real pages in a fake DOM, with fetch
// routed to the app. This checks the wiring between the markup and the script: which request each
// button sends and what the page does with the answer.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPage } from './dom.js';
import { testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());
afterEach(() => vi.restoreAllMocks());

/** Open `path` in the fake browser. `fetch` goes to the app; every call is recorded. */
async function open(t, path, { confirm } = {}) {
  const res = await t.get(path);
  expect(res.status, path).toBe(200);
  const fetch = vi.fn((url, init) => t.app.request(url, init));
  const page = loadPage(await res.text(), { fetch, ...(confirm ? { confirm } : {}) });
  return { ...page, fetch };
}

const input = (scope, name) => scope.querySelector(`[name="${name}"]`);

describe('M3 exit criterion, from the button: clicking "Full trial · $3" stores one row, no payment call', () => {
  it('records the click, reveals the email step with the click id, then stores the email on that row', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const outbound = vi.spyOn(globalThis, 'fetch');
    const page = await open(t, `/cases/${filed.caseId}`);

    const button = page.form(`/cases/${filed.caseId}/unlock`);
    const panel = page.document.getElementById('unlock-email');
    expect(panel.hidden).toBe(true);
    await page.submit(button);

    expect(page.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = page.fetch.mock.calls[0];
    expect(url).toBe(`/cases/${filed.caseId}/unlock`);
    expect(init.method).toBe('POST');
    const rows = await db.sql('SELECT id, email FROM unlock_clicks WHERE case_id = $1', [filed.caseId]);
    expect(rows).toHaveLength(1);
    expect(outbound).not.toHaveBeenCalled();

    // The fake door opens only after the click: the button goes, the honest panel appears.
    expect(button.hidden).toBe(true);
    expect(panel.hidden).toBe(false);
    const emailForm = page.form(`/cases/${filed.caseId}/unlock/email`);
    expect(input(emailForm, 'clickId').value).toBe(rows[0].id);

    input(emailForm, 'email').value = 'juror@example.com';
    await page.submit(emailForm);
    expect(page.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(page.fetch.mock.calls[1][1].body)).toEqual({ clickId: rows[0].id, email: 'juror@example.com' });
    expect(await db.sql('SELECT email FROM unlock_clicks WHERE case_id = $1', [filed.caseId])).toEqual([
      { email: 'juror@example.com' },
    ]);
    expect(emailForm.hidden).toBe(true);
    expect(page.document.getElementById('unlock-thanks').hidden).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('shows the error and re-enables the button when the email is rejected', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await open(t, `/cases/${filed.caseId}`);
    await page.submit(page.form(`/cases/${filed.caseId}/unlock`));
    const emailForm = page.form(`/cases/${filed.caseId}/unlock/email`);
    input(emailForm, 'email').value = 'not an email';
    await page.submit(emailForm);
    expect(emailForm.querySelector('[data-status]').textContent).toMatch(/email/i);
    expect(emailForm.querySelector('button').disabled).toBe(false);
    expect(emailForm.hidden).toBe(false);
  });
});

describe('the delete buttons', () => {
  it('the plaintiff confirms, the script sends DELETE with the plaintiff token, and the browser goes to /deleted', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const confirm = vi.fn(() => true);
    const page = await open(t, `/plaintiff/${filed.plaintiffToken}`, { confirm });

    await page.submit(page.form(`/cases/${filed.caseId}`));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/can't be undone/i));
    expect(page.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = page.fetch.mock.calls[0];
    expect(url).toBe(`/cases/${filed.caseId}`);
    expect(init.method).toBe('DELETE');
    expect(init.headers.authorization).toBe(`Bearer ${filed.plaintiffToken}`);
    expect(init.body).toBeUndefined();
    expect(page.location.replaced).toEqual(['/deleted']);
    expect(await db.rowsFor(filed.caseId)).toEqual({ cases: 0, votes: 0, reports: 0, unlock_clicks: 0 });
  });

  it('cancelling the confirmation sends nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await open(t, `/plaintiff/${filed.plaintiffToken}`, { confirm: () => false });
    await page.submit(page.form(`/cases/${filed.caseId}`));
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.location.replaced).toEqual([]);
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 1 });
  });

  it('the defendant deletes from the summons page with the summons token', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    const page = await open(t, `/summons/${filed.summonsToken}`);
    await page.submit(page.form(`/cases/${filed.caseId}`));
    expect(page.fetch.mock.calls[0][1].headers.authorization).toBe(`Bearer ${filed.summonsToken}`);
    expect(page.location.replaced).toEqual(['/deleted']);
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ cases: 0 });
  });
});

describe('the report form', () => {
  it('sends the chosen reason and note, then reloads into the taken-down page', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await open(t, `/cases/${filed.caseId}`);
    const form = page.form('/reports');
    form.querySelector('[value="names_someone"]').checked = true;
    input(form, 'note').value = 'Names my neighbour.';
    await page.submit(form);
    expect(JSON.parse(page.fetch.mock.calls[0][1].body)).toEqual({
      caseId: filed.caseId,
      reason: 'names_someone',
      note: 'Names my neighbour.',
    });
    expect(page.location.reloads).toBe(1);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(410);
  });
});

describe('M4: checkout and the appeal, from the buttons', () => {
  it('"Appeal the verdict · $3" asks the server for a Checkout Session and sends the browser to Stripe', async () => {
    const { paidMode } = await import('./stripe.js');
    const t = paidMode(db);
    const filed = await t.ruledCase();
    const page = await open(t, `/cases/${filed.caseId}`);
    await page.submit(page.form(`/cases/${filed.caseId}/checkout`));

    expect(page.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = page.fetch.mock.calls[0];
    expect(url).toBe(`/cases/${filed.caseId}/checkout`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    const [session] = t.stripe.created();
    expect(page.location.assigned).toEqual([session.url]);
    expect(session.url.startsWith('https://checkout.stripe.com/')).toBe(true);
  });

  it('the payer’s page sends the appeal with their click id as the bearer token, then reloads', async () => {
    const { paidMode } = await import('./stripe.js');
    const t = paidMode(db);
    const filed = await t.paidCase();
    const page = await open(t, `/appeals/${filed.clickId}`);
    const form = page.form(`/cases/${filed.caseId}/appeal`);
    form.querySelector('[value="defendant"]').checked = true;
    input(form, 'evidence').value = 'The taxi receipt, timestamped.';
    await page.submit(form);

    const [url, init] = page.fetch.mock.calls[0];
    expect(url).toBe(`/cases/${filed.caseId}/appeal`);
    expect(init.headers.authorization).toBe(`Bearer ${filed.clickId}`);
    expect(JSON.parse(init.body)).toEqual({ side: 'defendant', evidence: 'The taxi receipt, timestamped.' });
    expect(page.location.reloads).toBe(1);
    const [row] = await db.sql('SELECT appeal_evidence, appeal_ruled_at FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.appeal_evidence).toBe('The taxi receipt, timestamped.');
    expect(row.appeal_ruled_at).not.toBeNull();
  });

  it('"Hear the appeal" retries the hearing and reloads', async () => {
    const { paidMode } = await import('./stripe.js');
    const { APPEAL_RULING, judgeReply } = await import('./helpers.js');
    let up = false;
    const t = paidMode(db, {
      judge: async (f) => {
        if (f.appeal && !up) throw new Error('down');
        return f.appeal ? judgeReply('guilty', APPEAL_RULING) : judgeReply();
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const filed = await t.paidCase();
    await t.appeal(filed.caseId, filed.clickId);
    up = true;
    const page = await open(t, `/cases/${filed.caseId}`);
    await page.submit(page.form(`/cases/${filed.caseId}/appeal/rule`));
    expect(page.location.reloads).toBe(1);
    const [row] = await db.sql('SELECT appeal_verdict FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.appeal_verdict).toBe('guilty');
  });
});

describe('earlier forms still work through the same script', () => {
  it('filing reveals the receipt with the summons, jury, plaintiff and case links', async () => {
    const t = db.setup();
    const page = await open(t, '/');
    const form = page.form('/cases');
    const charge = 'Ate my labelled leftovers';
    input(form, 'charge').value = charge;
    input(form, 'testimony').value = 'The label had my name on it in capitals.';
    await page.submit(form);
    const [row] = await db.sql('SELECT id, summons_token, jury_token, plaintiff_token FROM cases WHERE charge = $1', [charge]);
    const receipt = page.document.getElementById('filed');
    expect(form.hidden).toBe(true);
    expect(receipt.hidden).toBe(false);
    expect(receipt.querySelector('[data-field="summonsUrl"]').value).toBe(`http://localhost/summons/${row.summons_token}`);
    expect(receipt.querySelector('[data-field="juryUrl"]').value).toBe(`http://localhost/jury/${row.jury_token}`);
    expect(receipt.querySelector('[data-field="plaintiffUrl"]').value).toBe(
      `http://localhost/plaintiff/${row.plaintiff_token}`,
    );
    expect(receipt.querySelector('[data-field="caseUrl"]').href).toBe(`http://localhost/cases/${row.id}`);
  });

  it('a jury vote reloads the jury page', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await open(t, `/jury/${filed.juryToken}`);
    const form = page.form(`/jury/${filed.juryToken}/votes`);
    form.querySelector('[value="guilty"]').checked = true;
    await page.submit(form);
    expect(page.location.reloads).toBe(1);
    expect(await db.rowsFor(filed.caseId)).toMatchObject({ votes: 1 });
  });

  it('testimony goes to the case page', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const page = await open(t, `/summons/${filed.summonsToken}`);
    const form = page.form(`/summons/${filed.summonsToken}/testimony`);
    input(form, 'testimony').value = 'I plead the fifth slice.';
    await page.submit(form);
    expect(page.location.assigned).toEqual([filed.caseUrl]);
  });
});
