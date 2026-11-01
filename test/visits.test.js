// M5 exit criterion 5: visitors are real people. Each browser that opens a case's page, summons link or
// jury link counts once for that case; the plaintiff's own browser, link-preview fetches (no script) and
// browsers that can't remember what they've seen never count. The script is the real CLIENT_JS in the
// fake DOM, with an in-memory localStorage per "browser".
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VISITORS_MAX } from '../src/store.js';
import { loadPage } from './dom.js';
import { newDevice, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

/** A browser's localStorage: string values, like the real one. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

const visitors = async (caseId) => (await db.sql('SELECT visitors FROM cases WHERE id = $1', [caseId]))[0]?.visitors;

/**
 * Open `path` in a browser whose storage is `storage` (undefined: none), let the script run, and wait for its
 * requests. `keepalive` is the browser's own transport option and never reaches a server, so the fake
 * network drops it (Node's Request refuses it with a streamed body).
 */
async function browse(t, path, storage) {
  const res = await t.get(path);
  const fetch = vi.fn((url, { keepalive, ...init } = {}) => t.app.request(url, init));
  const page = loadPage(await res.text(), { fetch, ...(storage === undefined ? {} : { localStorage: storage }) });
  await Promise.all(fetch.mock.results.map((r) => r.value));
  return { ...page, fetch, status: res.status };
}

describe('POST /visits', () => {
  it('adds one visitor to the case and answers 204, setting no cookie', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect(await visitors(filed.caseId)).toBe(0);
    const res = await t.post('/visits', { caseId: filed.caseId });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
    await t.post('/visits', { caseId: filed.caseId });
    expect(await visitors(filed.caseId)).toBe(2);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('stops counting at the per-case cap', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect(VISITORS_MAX).toBe(100);
    await db.sql('UPDATE cases SET visitors = $2 WHERE id = $1', [filed.caseId, VISITORS_MAX - 1]);
    for (let i = 0; i < 3; i += 1) expect((await t.post('/visits', { caseId: filed.caseId })).status).toBe(204);
    expect(await visitors(filed.caseId)).toBe(VISITORS_MAX);
  });

  it('404 for a case that doesn’t exist or a malformed id; 415 without JSON; 400 for broken JSON', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const otherId = newDevice().slice(0, 16);
    for (const caseId of [otherId, 'short', '', null, 42, `${filed.caseId}x`]) {
      expect((await t.post('/visits', { caseId })).status, String(caseId)).toBe(404);
    }
    expect((await t.post('/visits', {})).status).toBe(404);
    expect((await t.post('/visits', '{"caseId":')).status).toBe(400);
    const plain = await t.request('/visits', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: filed.caseId });
    expect(plain.status).toBe(415);
    expect(await visitors(filed.caseId)).toBe(0);
  });

  it('a link-preview bot fetching the pages (no script) counts nothing', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const path of [`/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`, `/jury/${filed.juryToken}`, `/cases/${filed.caseId}/card.png`]) {
      await t.get(path, { 'user-agent': 'WhatsApp/2.23 A' });
    }
    expect(await visitors(filed.caseId)).toBe(0);
  });
});

describe('which pages carry the visit marker', () => {
  it('the case page, the summons page and the jury page name the case; the plaintiff page marks its browser as the plaintiff', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const marker = `<main data-visit="${filed.caseId}">`;
    for (const path of [`/cases/${filed.caseId}`, `/summons/${filed.summonsToken}`, `/jury/${filed.juryToken}`]) {
      expect(await (await t.get(path)).text(), path).toContain(marker);
    }
    const voted = newDevice();
    await t.vote(filed.juryToken, { vote: 'guilty' }, voted);
    expect(await (await t.juryPage(filed.juryToken, voted)).text()).toContain(marker);
    expect(await (await t.get(`/plaintiff/${filed.plaintiffToken}`)).text()).toContain(
      `<main data-visit="${filed.caseId}" data-visitor="plaintiff">`,
    );
  });

  it('pages without a case’s content carry none: home, legal, deleted, not found, taken down, a declined jury', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const down = await t.fileCase();
    await t.report(down.caseId);
    const declined = await t.fileCase();
    await t.answer(declined.summonsToken);
    expect((await t.post(`/cases/${declined.caseId}/rule`)).status).toBe(422);
    for (const path of ['/', '/terms', '/privacy', '/deleted', '/no-such-page', `/cases/${down.caseId}`, `/jury/${down.juryToken}`, `/summons/${down.summonsToken}`, `/plaintiff/${down.plaintiffToken}`, `/jury/${declined.juryToken}`]) {
      expect(await (await t.get(path)).text(), path).not.toContain('data-visit');
    }
  });
});

describe('the client script counts each browser once per case', () => {
  it('the first open sends one JSON beacon, a reload sends none, another browser counts again', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const alice = memoryStorage();
    const first = await browse(t, `/cases/${filed.caseId}`, alice);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = first.fetch.mock.calls[0];
    expect(url).toBe('/visits');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ caseId: filed.caseId });
    expect(JSON.parse(alice.getItem('pc_seen'))).toEqual([filed.caseId]);
    expect(await visitors(filed.caseId)).toBe(1);

    expect((await browse(t, `/cases/${filed.caseId}`, alice)).fetch).not.toHaveBeenCalled();
    expect(await visitors(filed.caseId)).toBe(1);

    expect((await browse(t, `/cases/${filed.caseId}`, memoryStorage())).fetch).toHaveBeenCalledTimes(1);
    expect(await visitors(filed.caseId)).toBe(2);
  });

  it('the summons and jury links count too, but one browser opening all three pages is one visitor', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const defendant = memoryStorage();
    expect((await browse(t, `/summons/${filed.summonsToken}`, defendant)).fetch).toHaveBeenCalledTimes(1);
    expect((await browse(t, `/cases/${filed.caseId}`, defendant)).fetch).not.toHaveBeenCalled();
    expect((await browse(t, `/jury/${filed.juryToken}`, defendant)).fetch).not.toHaveBeenCalled();
    expect((await browse(t, `/jury/${filed.juryToken}`, memoryStorage())).fetch).toHaveBeenCalledTimes(1);
    expect(await visitors(filed.caseId)).toBe(2);
  });

  it('the browser that filed the case is the plaintiff: its own visits never count', async () => {
    const t = db.setup();
    const plaintiff = memoryStorage();
    const home = await browse(t, '/', plaintiff);
    expect(home.fetch).not.toHaveBeenCalled();
    const form = home.form('/cases');
    form.querySelector('[name="charge"]').value = 'Ate the last dumpling';
    form.querySelector('[name="testimony"]').value = 'It had my name on it. Literally, on a sticky note.';
    await home.submit(form);
    expect(home.fetch).toHaveBeenCalledTimes(1);
    expect(home.fetch.mock.calls[0][0]).toBe('/cases');
    // The receipt panel the script filled in holds the new case's links.
    const field = (name) => home.document.querySelector(`[data-field="${name}"]`);
    const caseId = field('caseUrl').href.split('/cases/')[1];
    expect(caseId).toMatch(/^[\w-]{16}$/);
    expect(JSON.parse(plaintiff.getItem('pc_seen'))).toEqual([caseId]);

    const paths = [`/cases/${caseId}`, new URL(field('juryUrl').value).pathname, new URL(field('plaintiffUrl').value).pathname];
    for (const path of paths) {
      expect((await browse(t, path, plaintiff)).fetch, path).not.toHaveBeenCalled();
    }
    expect(await visitors(caseId)).toBe(0);
    // The same pages in a friend's browser do count.
    expect((await browse(t, paths[1], memoryStorage())).fetch).toHaveBeenCalledTimes(1);
    expect(await visitors(caseId)).toBe(1);
  });

  it('a browser that opens the plaintiff link is the plaintiff too (their phone, say)', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const phone = memoryStorage();
    expect((await browse(t, `/plaintiff/${filed.plaintiffToken}`, phone)).fetch).not.toHaveBeenCalled();
    expect((await browse(t, `/cases/${filed.caseId}`, phone)).fetch).not.toHaveBeenCalled();
    expect(await visitors(filed.caseId)).toBe(0);
  });

  it('without storage, or when storage refuses to save, nothing is sent (so nothing is counted twice)', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    expect((await browse(t, `/cases/${filed.caseId}`, undefined)).fetch).not.toHaveBeenCalled();
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect((await browse(t, `/cases/${filed.caseId}`, full)).fetch).not.toHaveBeenCalled();
    expect(await visitors(filed.caseId)).toBe(0);
  });

  it('a corrupted list starts over once instead of silencing the browser for good', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    for (const junk of ['{not json', '"a string"', '{"an":"object"}', 'null']) {
      const storage = memoryStorage({ pc_seen: junk });
      expect((await browse(t, `/cases/${filed.caseId}`, storage)).fetch, junk).toHaveBeenCalledTimes(1);
      expect(JSON.parse(storage.getItem('pc_seen')), junk).toEqual([filed.caseId]);
    }
  });

  it('remembers at most the 200 most recent cases', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const old = Array.from({ length: 200 }, (_, i) => `case${String(i).padStart(12, '0')}`);
    const storage = memoryStorage({ pc_seen: JSON.stringify(old) });
    await browse(t, `/cases/${filed.caseId}`, storage);
    const seen = JSON.parse(storage.getItem('pc_seen'));
    expect(seen).toHaveLength(200);
    expect(seen.at(-1)).toBe(filed.caseId);
    expect(seen[0]).toBe(old[1]);
  });

  it('pages without the marker send nothing: home, not found, taken down', async () => {
    const t = db.setup();
    const down = await t.fileCase();
    await t.report(down.caseId);
    for (const path of ['/', '/no-such-page', `/cases/${down.caseId}`]) {
      const page = await browse(t, path, memoryStorage());
      expect(page.fetch, path).not.toHaveBeenCalled();
    }
    expect(await visitors(down.caseId)).toBe(0);
  });

  it('existing forms still work on a page that sent a beacon', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const juror = await browse(t, `/jury/${filed.juryToken}`, memoryStorage());
    const ballot = juror.form(`/jury/${filed.juryToken}/votes`);
    ballot.querySelector('[value="guilty"]').checked = true;
    await juror.submit(ballot);
    expect(juror.fetch).toHaveBeenCalledTimes(2);
    expect(juror.fetch.mock.calls[1][0]).toBe(`/jury/${filed.juryToken}/votes`);
    expect(juror.location.reloads).toBe(1);
  });
});
