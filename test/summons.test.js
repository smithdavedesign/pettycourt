import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, testDatabase } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const SECRET_TITLE = 'The Great Leftovers Heist';
const SECRET_CHARGE = 'Ate the last dumpling while I was in the shower';
const SECRET_TESTIMONY = 'I had labelled the container with a sticky note.';

/** Flip one character so the token has the right shape but matches nothing. */
function nearMiss(token) {
  const last = token.at(-1);
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

async function fileSecretCase(t) {
  return t.fileCase({ title: SECRET_TITLE, charge: SECRET_CHARGE, testimony: SECRET_TESTIMONY });
}

function expectNoLeak(text, filed) {
  for (const secret of [SECRET_TITLE, SECRET_CHARGE, SECRET_TESTIMONY, filed.caseId, filed.summonsToken, filed.juryToken]) {
    expect(text).not.toContain(secret);
  }
}

describe('GET /summons/:token', () => {
  it('shows the charge, the plaintiff testimony, the deadline and the answer form', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    const res = await t.get(`/summons/${filed.summonsToken}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const page = await res.text();
    expect(page).toContain(SECRET_TITLE);
    expect(page).toContain(SECRET_CHARGE);
    expect(page).toContain(SECRET_TESTIMONY);
    expect(page).toContain(`data-api="/summons/${filed.summonsToken}/testimony"`);
    expect(page).toContain('name="testimony"');
    expect(page).toMatch(/24 hours/);
  });

  it('shows the answer that is on record instead of the form once the defendant has testified', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    await t.answer(filed.summonsToken, 'I plead the fifth dumpling.');
    const page = await (await t.get(`/summons/${filed.summonsToken}`)).text();
    expect(page).toContain('I plead the fifth dumpling.');
    expect(page).not.toContain('name="testimony"');
    expect(page).toContain(`/cases/${filed.caseId}`);
  });
});

describe('POST /summons/:token/testimony', () => {
  it('stores the first answer with 201, returns 409 on a second one and keeps the first answer', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);

    const first = await t.answer(filed.summonsToken, 'First answer: the dumpling was communal.');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.caseId).toBe(filed.caseId);
    expect(firstBody.caseUrl).toBe(`http://localhost/cases/${filed.caseId}`);

    const second = await t.answer(filed.summonsToken, 'Second answer: I take it all back.');
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already/i);

    const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.defendant_testimony).toBe('First answer: the dumpling was communal.');
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('First answer: the dumpling was communal.');
    expect(page).not.toContain('Second answer');
  });

  it('accepts exactly one of two simultaneous submissions', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    const results = await Promise.all([
      t.answer(filed.summonsToken, 'Answer A'),
      t.answer(filed.summonsToken, 'Answer B'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
    expect(['Answer A', 'Answer B']).toContain(row.defendant_testimony);
  });

  it('rejects blank or oversized testimony with 400 and still allows a real answer afterwards', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    expect((await t.answer(filed.summonsToken, '   ')).status).toBe(400);
    expect((await t.answer(filed.summonsToken, 'x'.repeat(2001))).status).toBe(400);
    expect((await t.post(`/summons/${filed.summonsToken}/testimony`, {})).status).toBe(400);
    expect((await t.answer(filed.summonsToken, 'Now I answer properly.')).status).toBe(201);
  });

  it('still accepts a late answer after the deadline if no ruling exists yet', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    t.advance(30 * HOUR);
    expect((await t.answer(filed.summonsToken)).status).toBe(201);
  });

  it('returns 409 once the case has been ruled, even if the defendant never answered', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    t.advance(25 * HOUR);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);

    const late = await t.answer(filed.summonsToken, 'Sorry, I was in the shower.');
    expect(late.status).toBe(409);
    expect((await late.json()).error).toMatch(/closed|ruled/i);
    const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.defendant_testimony).toBeNull();

    const page = await (await t.get(`/summons/${filed.summonsToken}`)).text();
    expect(page).not.toContain('name="testimony"');
    expect(page).toMatch(/closed|ruled/i);
  });
});

describe('POST /summons/:token/testimony on a declined case', () => {
  it('returns 409 saying the court declined, and stores nothing', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const filed = await fileSecretCase(t);
    t.advance(25 * HOUR);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(422);

    const late = await t.answer(filed.summonsToken, 'Sorry I am late.');
    expect(late.status).toBe(409);
    expect((await late.json()).error).toMatch(/declined/i);
    const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
    expect(row.defendant_testimony).toBeNull();
    expect(await (await t.get(`/summons/${filed.summonsToken}`)).text()).toMatch(/declined to hear it/);
  });
});

describe('a wrong token returns 404 and leaks no case content', () => {
  const wrongTokens = {
    'a one-character near miss of the summons token': (f) => nearMiss(f.summonsToken),
    'a random well-formed token': () => 'Q'.repeat(32),
    'the jury token': (f) => f.juryToken,
    'the case id': (f) => f.caseId,
    'a malformed token': () => '../../etc/passwd',
    'an oversized token': () => 'A'.repeat(5000),
  };

  for (const [name, makeToken] of Object.entries(wrongTokens)) {
    it(`GET /summons/:token with ${name}`, async () => {
      const t = db.setup();
      const filed = await fileSecretCase(t);
      const res = await t.get(`/summons/${encodeURIComponent(makeToken(filed))}`);
      expect(res.status).toBe(404);
      expectNoLeak(await res.text(), filed);
    });

    it(`POST /summons/:token/testimony with ${name}`, async () => {
      const t = db.setup();
      const filed = await fileSecretCase(t);
      const res = await t.answer(encodeURIComponent(makeToken(filed)), 'Let me in.');
      expect(res.status).toBe(404);
      expectNoLeak(await res.text(), filed);
      const [row] = await db.sql('SELECT defendant_testimony FROM cases WHERE id = $1', [filed.caseId]);
      expect(row.defendant_testimony).toBeNull();
    });
  }

  it('GET /cases/:id with a wrong id', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    for (const id of [nearMiss(filed.caseId), filed.summonsToken, 'nope']) {
      const res = await t.get(`/cases/${id}`);
      expect(res.status).toBe(404);
      expectNoLeak(await res.text(), filed);
    }
  });

  it('POST /cases/:id/rule with a wrong id never calls the judge', async () => {
    const t = db.setup();
    const filed = await fileSecretCase(t);
    await t.answer(filed.summonsToken);
    const res = await t.post(`/cases/${nearMiss(filed.caseId)}/rule`);
    expect(res.status).toBe(404);
    expectNoLeak(await res.text(), filed);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('an unknown path is a plain 404', async () => {
    const t = db.setup();
    const res = await t.get('/jury/whatever');
    expect(res.status).toBe(404);
  });
});
