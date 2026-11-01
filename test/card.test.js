import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  RULING_EXCERPT_CHARS,
  cardElement,
  cardModel,
  cardText,
  renderCardPng,
  renderCardSvg,
} from '../src/card.js';
import { GOOD_RULING, HOUR, judgeReply, newDevice, pngSize, testDatabase, words } from './helpers.js';


const db = testDatabase();
beforeAll(() => db.open());
afterAll(() => db.close());

const XSS = '<script>alert("pwned")</script>';
const LONG_RULING = `${words(199, 'objection')}.`;

async function getCard(t, caseId, headers) {
  const res = await t.get(`/cases/${caseId}/card.png`, headers);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

/** Write a title straight to the database, past the 120-character filing limit. */
async function forceTitle(caseId, title) {
  await db.sql('UPDATE cases SET title = $2 WHERE id = $1', [caseId, title]);
}

function expectCardPng(res, bytes) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(pngSize(bytes)).toEqual({ width: 1080, height: 1350 });
}

/** Every string drawn by the card, and every element type, from the element tree. */
function walk(node, out = { texts: [], types: [], props: [] }) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.types.push(node.type);
  out.props.push(...Object.keys(node.props ?? {}));
  walk(node.props?.children, out);
  return out;
}

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The text content of every <text> element in a satori SVG rendered with embedFont: false. */
function svgTexts(svg) {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => decode(m[1]));
}

describe('M2 exit criterion: GET /cases/:id/card.png is a 1080×1350 PNG, even with a 300-character title', () => {
  it('returns image/png at 1080×1350 for a freshly filed case', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
    expect(CARD_WIDTH).toBe(1080);
    expect(CARD_HEIGHT).toBe(1350);
  });

  it('renders without error for a 300-character title (words)', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    const title = 'The Great Shower Affair, in which '.repeat(10).slice(0, 300);
    expect(title).toHaveLength(300);
    await forceTitle(filed.caseId, title);
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
  });

  it('renders without error for a 300-character title with no spaces', async () => {
    const t = db.setup();
    const filed = await t.ruledCase();
    await forceTitle(filed.caseId, 'W'.repeat(300));
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
  });

  it('renders every field at its maximum length with a 200-word ruling and a full jury', async () => {
    const t = db.setup({ judge: async () => judgeReply('not_guilty', LONG_RULING) });
    const filed = await t.fileCase({ title: 'T'.repeat(120), charge: 'c '.repeat(140).trim(), testimony: 'x'.repeat(2000) });
    await t.answer(filed.summonsToken, 'y'.repeat(2000));
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
    for (let i = 0; i < 12; i += 1) await t.vote(filed.juryToken, { vote: i % 3 ? 'guilty' : 'not_guilty' }, newDevice());
    await forceTitle(filed.caseId, `${'A long title '.repeat(23)}!`.slice(0, 300));
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
  });

  it('renders titles the card font cannot draw (emoji, CJK, right-to-left)', async () => {
    const t = db.setup();
    for (const title of ['🍕🍕🍕', '你好，世界', 'مرحبا بالعالم', 'Zoë vs. Łukasz: Привет 🙃']) {
      const filed = await t.fileCase({ title });
      const { res, bytes } = await getCard(t, filed.caseId);
      expectCardPng(res, bytes);
    }
  });

  it('renders every verdict, a default judgment and the pending state', async () => {
    for (const verdict of ['guilty', 'not_guilty', 'split']) {
      const t = db.setup({ judge: async () => judgeReply(verdict) });
      const filed = await t.ruledCase();
      const { res, bytes } = await getCard(t, filed.caseId);
      expectCardPng(res, bytes);
    }
    const t = db.setup({ judge: async () => judgeReply('guilty') });
    const filed = await t.fileCase();
    t.advance(25 * HOUR);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(200);
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
  });
});

describe('M2 exit criterion: a <script> charge is text in the page and the card', () => {
  it('escapes it on the results page and draws it as plain text on the card', async () => {
    const t = db.setup();
    const filed = await t.ruledCase({ title: XSS, charge: XSS });

    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;');

    const found = await db.store.getCase(filed.caseId);
    const model = cardModel(found, await db.store.getJury(filed.caseId), 'localhost');
    expect(model.charge).toBe(XSS);

    // The element tree carries it as a text child: no script element, no raw-HTML escape hatch.
    const tree = walk(cardElement(model));
    expect(tree.texts).toContain(XSS);
    expect(tree.types.every((type) => typeof type === 'string' && ['div', 'span'].includes(type))).toBe(true);
    expect(tree.props).not.toContain('dangerouslySetInnerHTML');

    // With text kept as <text>, the SVG holds it escaped, and it decodes back to the exact characters.
    const svg = await renderCardSvg(model, { embedFont: false });
    expect(svg).not.toMatch(/<script/i);
    expect(svg).toContain('&lt;');
    expect(svgTexts(svg).join('')).toContain(XSS);

    // The real card (text as paths) has no script either, and the route renders it.
    const embedded = await renderCardSvg(model);
    expect(embedded).not.toMatch(/<script/i);
    const { res, bytes } = await getCard(t, filed.caseId);
    expectCardPng(res, bytes);
  });
});

describe('card route', () => {
  it('returns 404 for a wrong id, a malformed id and a declined case', async () => {
    const t = db.setup({ judge: async () => judgeReply('declined', '') });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    expect((await t.post(`/cases/${filed.caseId}/rule`)).status).toBe(422);
    for (const id of ['AAAAAAAAAAAAAAAA', 'nope', filed.juryToken, filed.caseId]) {
      const res = await t.get(`/cases/${id}/card.png`);
      expect(res.status, id).toBe(404);
      expect(res.headers.get('content-type')).not.toBe('image/png');
    }
  });

  it('revalidates instead of re-rendering: a matching If-None-Match gets 304 with no render', async () => {
    const renderCard = vi.fn(renderCardPng);
    const t = db.setup({ renderCard });
    const filed = await t.fileCase();

    const first = await t.get(`/cases/${filed.caseId}/card.png`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(renderCard).toHaveBeenCalledTimes(1);

    const again = await t.get(`/cases/${filed.caseId}/card.png`, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect(again.headers.get('etag')).toBe(etag);
    expect(renderCard).toHaveBeenCalledTimes(1);

    // A vote changes what the card draws, so the old ETag no longer matches.
    await t.vote(filed.juryToken, { vote: 'guilty' }, newDevice());
    const changed = await t.get(`/cases/${filed.caseId}/card.png`, { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(renderCard).toHaveBeenCalledTimes(2);
  });

  it('renders an unchanged card once for many first-time viewers, and evicts the oldest past the cache size', async () => {
    const renderCard = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const t = db.setup({ renderCard });
    const filed = await t.fileCase();
    for (let i = 0; i < 5; i += 1) expect((await t.get(`/cases/${filed.caseId}/card.png`)).status).toBe(200);
    expect(renderCard).toHaveBeenCalledTimes(1);

    // 32 other cards push the first one out; viewing it again renders it again.
    for (let i = 0; i < 32; i += 1) {
      const other = await t.fileCase({ title: `Case number ${i}` });
      await t.get(`/cases/${other.caseId}/card.png`);
    }
    expect(renderCard).toHaveBeenCalledTimes(33);
    await t.get(`/cases/${filed.caseId}/card.png`);
    expect(renderCard).toHaveBeenCalledTimes(34);
  });

  it('a renderer failure is a logged 500, is not cached, and does not affect other routes', async () => {
    const renderCard = vi.fn(async () => {
      throw new Error('wasm missing');
    });
    const t = db.setup({ renderCard });
    const filed = await t.fileCase();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    try {
      expect((await t.get(`/cases/${filed.caseId}/card.png`)).status).toBe(500);
      expect((await t.get(`/cases/${filed.caseId}/card.png`)).status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(renderCard).toHaveBeenCalledTimes(2);
    expect(errors.join('\n')).toMatch(/wasm missing/);
    expect((await t.get(`/cases/${filed.caseId}`)).status).toBe(200);
  });
});

describe('the card on the results page', () => {
  it('links previews to the card with an absolute og:image on every state', async () => {
    const t = db.setup();
    const filed = await t.fileCase({ title: 'The Shower Affair' });
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).toContain(`<meta property="og:image" content="http://localhost/cases/${filed.caseId}/card.png">`);
    expect(page).toContain('<meta property="og:title" content="The Shower Affair">');
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('shows the card and a download link only once the judge has ruled', async () => {
    const t = db.setup();
    const filed = await t.fileCase();
    const before = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(before).not.toContain(`<img src="/cases/${filed.caseId}/card.png"`);

    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const after = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(after).toContain(`<img src="/cases/${filed.caseId}/card.png"`);
    expect(after).toMatch(new RegExp(`<a href="/cases/${filed.caseId}/card.png" download="[^"]+\\.png">`));
  });

  it('a declined case has no card link or og:image', async () => {
    const t = db.setup({ judge: async () => judgeReply('declined', '') });
    const filed = await t.fileCase();
    await t.answer(filed.summonsToken);
    await t.post(`/cases/${filed.caseId}/rule`);
    const page = await (await t.get(`/cases/${filed.caseId}`)).text();
    expect(page).not.toContain('card.png');
  });
});

describe('cardModel', () => {
  const base = {
    id: 'AAAAAAAAAAAAAAAA',
    title: 'The Shower Affair',
    charge: 'Said "five minutes away" while still in the shower',
    verdict: null,
    ruling: null,
    defaultJudgment: null,
    ruledAt: null,
    declinedAt: null,
  };
  const noVotes = { guilty: 0, notGuilty: 0, total: 0 };

  it('labels each verdict and the pending state', () => {
    expect(cardModel(base, noVotes, 'x').verdict).toBe('Verdict pending');
    const ruled = { ...base, ruling: GOOD_RULING, ruledAt: new Date(), defaultJudgment: false };
    expect(cardModel({ ...ruled, verdict: 'guilty' }, noVotes, 'x').verdict).toBe('Guilty');
    expect(cardModel({ ...ruled, verdict: 'not_guilty' }, noVotes, 'x').verdict).toBe('Not guilty');
    expect(cardModel({ ...ruled, verdict: 'split' }, noVotes, 'x').verdict).toBe('Split decision');
  });

  it('describes the jury split, including no votes', () => {
    expect(cardModel(base, noVotes, 'x').jury).toBe('No jury votes yet');
    expect(cardModel(base, { guilty: 3, notGuilty: 0, total: 3 }, 'x').jury).toBe('3 guilty · 0 not guilty');
  });

  it('credits the host so viewers can file their own case', () => {
    expect(cardModel(base, noVotes, 'pettycourt.vercel.app').credit).toBe('File your own case at pettycourt.vercel.app');
    expect(cardModel(base, noVotes, 'h'.repeat(500)).credit.length).toBeLessThanOrEqual(100);
  });

  it('excerpts a long ruling at a word boundary with an ellipsis', () => {
    const model = cardModel({ ...base, verdict: 'guilty', ruling: LONG_RULING, ruledAt: new Date() }, noVotes, 'x');
    expect(model.ruling.length).toBeLessThanOrEqual(RULING_EXCERPT_CHARS);
    expect(model.ruling.endsWith('…')).toBe(true);
    expect(model.ruling).toMatch(/objection…$/);
    const shortRuling = words(40, 'order');
    expect(shortRuling.length).toBeLessThan(RULING_EXCERPT_CHARS);
    const short = cardModel({ ...base, verdict: 'guilty', ruling: shortRuling, ruledAt: new Date() }, noVotes, 'x');
    expect(short.ruling).toBe(shortRuling);
  });

  it('flattens line breaks in the ruling', () => {
    const model = cardModel({ ...base, verdict: 'split', ruling: 'Order.\n\nCourt is adjourned.', ruledAt: new Date() }, noVotes, 'x');
    expect(model.ruling).toBe('Order. Court is adjourned.');
  });
});

describe('cardText', () => {
  it('keeps Latin, accented, Cyrillic and Vietnamese text and punctuation', () => {
    const text = 'Zoë vs. Łukasz — “Привет” in Việt Nam… <b>&</b>';
    expect(cardText(text, '?')).toBe(text);
  });

  it('drops glyphs the card font cannot draw and tidies the spaces they leave', () => {
    expect(cardText('Pizza 🍕 thief 🍕🍕', '?')).toBe('Pizza thief');
    expect(cardText('你好 friend', '?')).toBe('friend');
  });

  it('uses the fallback when nothing drawable is left', () => {
    expect(cardText('🍕🍕🍕', 'Untitled case')).toBe('Untitled case');
    expect(cardText('   ', 'Untitled case')).toBe('Untitled case');
  });

  it('flattens line breaks and tabs into single spaces', () => {
    expect(cardText(' Order.\n\n\tCourt\r\nis adjourned. ', '?')).toBe('Order. Court is adjourned.');
  });

  // The input is "Zoe" + U+0308 (combining diaeresis); the expected value is the composed "Zoë".
  it('normalises decomposed accents so they can be drawn', () => {
    expect(cardText('Zoë', '?')).toBe('Zoë');
  });
});
