import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECLINE_MESSAGE } from '../src/scope.js';
import { GOOD_RULING, HOUR, judgeReply, testDatabase, words } from './helpers.js';

const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const wordCount = (text) => text.trim().split(/\s+/).length;

async function storedRuling(caseId) {
  const [row] = await db.sql(
    'SELECT verdict, ruling, ruled_at, default_judgment, declined_at FROM cases WHERE id = $1',
    [caseId],
  );
  return row;
}

async function expectNothingStored(caseId) {
  const row = await storedRuling(caseId);
  expect(row.ruling).toBeNull();
  expect(row.verdict).toBeNull();
  expect(row.ruled_at).toBeNull();
}

async function readyCase(t) {
  const filed = await t.fileCase();
  const answered = await t.answer(filed.summonsToken, 'The shower was part of the journey. I was mentally en route.');
  expect(answered.status).toBe(201);
  return filed;
}

describe('POST /cases/:id/rule with both testimonies', () => {
  it('returns a ruling of 40–200 words and stores it', async () => {
    const t = db.setup();
    const filed = await readyCase(t);
    const res = await t.post(`/cases/${filed.caseId}/rule`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(wordCount(body.ruling)).toBeGreaterThanOrEqual(40);
    expect(wordCount(body.ruling)).toBeLessThanOrEqual(200);
    expect(body.ruling).toBe(GOOD_RULING);
    expect(body.verdict).toBe('split');
    expect(body.defaultJudgment).toBe(false);

    const row = await storedRuling(filed.caseId);
    expect(row.ruling).toBe(GOOD_RULING);
    expect(row.verdict).toBe('split');
    expect(row.default_judgment).toBe(false);
    expect(row.ruled_at).not.toBeNull();

    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('five minutes away&quot; is a statement of hope');
    expect(page).toMatch(/split decision/i);
  });

  it('sends the judge the charge and both testimonies', async () => {
    const t = db.setup();
    const filed = await readyCase(t);
    await t.post(`/cases/${filed.caseId}/rule`);

    expect(t.judge).toHaveBeenCalledTimes(1);
    const [caseFile] = t.judge.mock.calls[0];
    expect(caseFile).toEqual({
      title: 'Said "five minutes away" while still in the shower',
      charge: 'Said "five minutes away" while still in the shower',
      plaintiffTestimony: 'I waited forty minutes outside the cinema and missed the trailers.',
      defendantTestimony: 'The shower was part of the journey. I was mentally en route.',
      defendantAppeared: true,
    });
  });

  it.each([
    ['exactly 40 words', words(40)],
    ['exactly 200 words', words(200)],
  ])('accepts a ruling of %s', async (_name, ruling) => {
    const t = db.setup({ judge: async () => judgeReply('guilty', ruling) });
    const filed = await readyCase(t);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBe('guilty');
  });

  it('accepts JSON wrapped in a markdown code fence', async () => {
    const t = db.setup({ judge: async () => '```json\n' + judgeReply('not_guilty') + '\n```' });
    const filed = await readyCase(t);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBe('not_guilty');
  });

  it('is idempotent: a second call returns the stored ruling without calling the judge again', async () => {
    const t = db.setup();
    const filed = await readyCase(t);
    const first = await (await t.post(`/cases/${filed.caseId}/rule`)).json();
    const again = await t.post(`/cases/${filed.caseId}/rule`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(t.judge).toHaveBeenCalledTimes(1);
  });
});

describe('POST /cases/:id/rule when the judge misbehaves returns 502 and stores nothing', () => {
  const malformed = {
    'plain prose': 'The defendant is guilty, obviously.',
    'truncated JSON': '{"verdict": "guilty", "ruling": "Order in the',
    'an empty reply': '',
    'a JSON string': JSON.stringify('guilty'),
    'a JSON array': JSON.stringify(['guilty', GOOD_RULING]),
    'a missing ruling': JSON.stringify({ verdict: 'guilty' }),
    'an unknown verdict': judgeReply('acquitted-with-cake'),
    'a numeric ruling': JSON.stringify({ verdict: 'guilty', ruling: 42 }),
    'a 10-word ruling': judgeReply('guilty', words(10)),
    'a 39-word ruling': judgeReply('guilty', words(39)),
    'a 250-word ruling': judgeReply('guilty', words(250)),
    'a ruling with very long words': judgeReply('guilty', words(50, 'x'.repeat(60))),
  };

  for (const [name, reply] of Object.entries(malformed)) {
    it(`for ${name}`, async () => {
      const t = db.setup({ judge: async () => reply });
      const filed = await readyCase(t);
      const res = await t.post(`/cases/${filed.caseId}/rule`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/judge/i);
      await expectNothingStored(filed.caseId);
    });
  }

  it('when the judge call throws (network error, 429, timeout)', async () => {
    const t = db.setup({
      judge: async () => {
        throw new Error('fetch failed');
      },
    });
    const filed = await readyCase(t);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(502);
    await expectNothingStored(filed.caseId);
  });

  it('and a retry after a bad reply can still rule', async () => {
    let calls = 0;
    const t = db.setup({ judge: async () => (calls++ === 0 ? 'not json' : judgeReply()) });
    const filed = await readyCase(t);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(502);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
    expect((await storedRuling(filed.caseId)).ruling).toBe(GOOD_RULING);
  });

  it('returns 503 and stores nothing when no judge is configured', async () => {
    const notConfigured = Object.assign(new Error('The judge is not configured'), { code: 'JUDGE_NOT_CONFIGURED' });
    const t = db.setup({
      judge: async () => {
        throw notConfigured;
      },
    });
    const filed = await readyCase(t);
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(503);
    await expectNothingStored(filed.caseId);
  });
});

describe('POST /cases/:id/rule and the defendant deadline', () => {
  it('returns 409 before the defendant answers and before the deadline, without calling the judge', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/defendant/i);
    expect(t.judge).not.toHaveBeenCalled();
    await expectNothingStored(filed.caseId);
  });

  it('still returns 409 one second before the deadline', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(24 * HOUR - 1000);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(409);
    expect(t.judge).not.toHaveBeenCalled();
  });

  it('after the deadline rules that the defendant failed to appear', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    t.advance(24 * HOUR);
    const res = await t.post(`/cases/${filed.caseId}/rule`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruling).toMatch(/defendant failed to appear/i);
    expect(body.defaultJudgment).toBe(true);
    expect(wordCount(body.ruling)).toBeGreaterThanOrEqual(40);
    expect(wordCount(body.ruling)).toBeLessThanOrEqual(200);

    const [caseFile] = t.judge.mock.calls[0];
    expect(caseFile.defendantAppeared).toBe(false);
    expect(caseFile.defendantTestimony).toBeNull();

    const row = await storedRuling(filed.caseId);
    expect(row.default_judgment).toBe(true);
    expect(row.ruling).toMatch(/defendant failed to appear/i);

    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toMatch(/defendant failed to appear/i);
  });

  it('does not repeat "failed to appear" when the model already says it', async () => {
    const ruling = `The Defendant failed to appear, which this court notes with theatrical disappointment. ${words(40)}`;
    const t = db.setup({ judge: async () => judgeReply('guilty', ruling) });
    const filed = await t.fileCase();
    t.advance(25 * HOUR);
    const body = await (await t.post(`/cases/${filed.caseId}/rule`)).json();
    expect(body.ruling).toBe(ruling);
    expect(body.ruling.match(/failed to appear/gi)).toHaveLength(1);
  });

  it('counts the added "failed to appear" sentence toward the 200-word limit', async () => {
    const t = db.setup({ judge: async () => judgeReply('guilty', words(198)) });
    const filed = await t.fileCase();
    t.advance(25 * HOUR);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(502);
    await expectNothingStored(filed.caseId);
  });
});

describe('POST /cases/:id/rule races', () => {
  it('a no-show ruling is not stored if the defendant answers while the judge deliberates', async () => {
    let filed;
    const t = db.setup({
      judge: async () => {
        await db.store.submitDefendantTestimony(filed.summonsToken, 'Made it, sorry!', new Date());
        return judgeReply('guilty');
      },
    });
    filed = await t.fileCase();
    t.advance(25 * HOUR);

    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/defendant just answered/i);
    await expectNothingStored(filed.caseId);

    // Calling again now hears both sides.
    const again = await t.post(`/cases/${filed.caseId}/rule`);
    expect(again.status).toBe(200);
    expect((await again.json()).defaultJudgment).toBe(false);
  });

  it('when another request stores a ruling first, returns that ruling instead of overwriting it', async () => {
    let filed;
    const winner = `The winning ruling. ${words(45)}`;
    const t = db.setup({
      judge: async () => {
        await db.store.saveRuling(filed.caseId, {
          verdict: 'guilty',
          ruling: winner,
          defaultJudgment: false,
          defendantAppeared: true,
          at: new Date(),
        });
        return judgeReply('not_guilty');
      },
    });
    filed = await readyCase(t);

    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruling).toBe(winner);
    expect(body.verdict).toBe('guilty');
    expect((await storedRuling(filed.caseId)).ruling).toBe(winner);
  });
});

describe('POST /cases/:id/rule when the model declines', () => {
  it('returns 422 with the decline message, stores no ruling and does not ask again', async () => {
    const t = db.setup({ judge: async () => JSON.stringify({ verdict: 'declined', ruling: '' }) });
    const filed = await readyCase(t);

    const res = await t.post(`/cases/${filed.caseId}/rule`);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(DECLINE_MESSAGE);
    await expectNothingStored(filed.caseId);
    expect((await storedRuling(filed.caseId)).declined_at).not.toBeNull();

    const again = await t.post(`/cases/${filed.caseId}/rule`);
    expect(again.status).toBe(422);
    expect(t.judge).toHaveBeenCalledTimes(1);

    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain('declines to rule');
    expect(page).not.toContain('data-api="/cases/');
  });
});
