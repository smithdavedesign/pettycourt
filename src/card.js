// The shareable verdict card: a 1080×1350 PNG (the 4:5 portrait that feeds and chats show uncropped).
// satori lays out an element tree and draws its text as <path>s; resvg-wasm rasterises the SVG.
// User and model text only ever enter the tree as text children, so markup such as <script> is drawn
// as characters and never parsed. satori (~1.6 MB) and resvg (~2.5 MB of wasm) load on the first card
// request, not with the app.
//
//   cardModel(case, jury, host)  pure: exactly what the card draws (also the input of the ETag);
//                                after an appeal, the final verdict with "Upheld/Overturned on appeal"
//   cardElement(model)           the satori element tree
//   renderCardSvg / renderCardPng
//   shareElement / renderSharePng  go-live: the public pages' 1200×630 link-preview image (no case text)
//   setCardAssets(load)          the Cloudflare Worker's loader (src/worker.js): a Worker can't read files or
//                                compile wasm at run time, so its fonts and wasm are bundled at deploy
//
// satori's standalone build is used, so its layout engine's wasm comes from the same loader as resvg's
// instead of being compiled from bytes inlined in satori's code.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import loraUnicode from '@fontsource/lora/unicode.json' with { type: 'json' };
import { VERDICT_LABELS } from './judge.js';
import { SHARE_IMAGE } from './seo.js';
import { juryLine } from './views.js';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const RULING_EXCERPT_CHARS = 420;
const TITLE_MAX_CHARS = 300;
const HOST_MAX_CHARS = 60;
// Bump when the design changes, so cached cards stop matching their old ETag.
const CARD_VERSION = 1;

// Lora (SIL Open Font License) from @fontsource. Each subset gets its own family name because satori
// only falls back across *different* families for glyphs the first one lacks. The specifiers are
// static strings so Vercel's file tracer ships the files with the function.
export const FONT_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'vietnamese'];
const FONT_FAMILY = FONT_SUBSETS.map((subset) => `Lora-${subset}`).join(', ');
const fontFiles = (require) => [
  ['latin', 400, require.resolve('@fontsource/lora/files/lora-latin-400-normal.woff2')],
  ['latin', 700, require.resolve('@fontsource/lora/files/lora-latin-700-normal.woff2')],
  ['latin-ext', 400, require.resolve('@fontsource/lora/files/lora-latin-ext-400-normal.woff2')],
  ['latin-ext', 700, require.resolve('@fontsource/lora/files/lora-latin-ext-700-normal.woff2')],
  ['cyrillic', 400, require.resolve('@fontsource/lora/files/lora-cyrillic-400-normal.woff2')],
  ['cyrillic', 700, require.resolve('@fontsource/lora/files/lora-cyrillic-700-normal.woff2')],
  ['vietnamese', 400, require.resolve('@fontsource/lora/files/lora-vietnamese-400-normal.woff2')],
  ['vietnamese', 700, require.resolve('@fontsource/lora/files/lora-vietnamese-700-normal.woff2')],
];

const COLORS = { paper: '#fbf7ef', ink: '#1d1a16', accent: '#7a1f1f', muted: '#6b6359' };

/** Code point ranges the bundled subsets can draw, from the font package's own unicode.json. */
let drawableRanges;
function isDrawable(codePoint) {
  drawableRanges ??= FONT_SUBSETS.flatMap((subset) => loraUnicode[subset].split(',')).map(
    (range) => {
      const [start, end = start] = range.trim().replace(/U\+/g, '').split('-');
      return [parseInt(start, 16), parseInt(end, 16)];
    },
  );
  return drawableRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Text as the card can draw it: one line, NFC, with control and format characters removed and
 * glyphs the fonts lack (emoji, CJK…) dropped instead of drawn as empty boxes.
 */
export function cardText(text, fallback) {
  let out = '';
  for (const char of String(text ?? '').normalize('NFC')) {
    if (/\s/u.test(char)) out += ' ';
    else if (/[\p{Cc}\p{Cf}]/u.test(char)) continue;
    else out += isDrawable(char.codePointAt(0)) ? char : ' ';
  }
  return out.replace(/ {2,}/g, ' ').trim() || fallback;
}

/** At most `max` characters, cut at a word boundary when there is one, ending in an ellipsis. */
function excerpt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const atWord = space > max / 2 ? cut.slice(0, space) : cut;
  return `${atWord.replace(/[\s,;:.!?—–-]+$/u, '')}…`;
}

/**
 * Everything the card draws, already reduced to drawable text.
 * @param {import('./store.js').Case} c
 * @param {import('./store.js').JuryTally} jury
 * @param {string} host  the site's host, for the "file your own case" credit
 */
export function cardModel(c, jury, host) {
  const ruled = Boolean(c.ruledAt);
  // After a heard appeal (M4) the card shows the final verdict and the appeal's ruling.
  const appealed = ruled && Boolean(c.appealRuledAt);
  const [verdict, ruling] = appealed ? [c.appealVerdict, c.appealRuling] : [c.verdict, c.ruling];
  return {
    title: excerpt(cardText(c.title, 'Untitled case'), TITLE_MAX_CHARS),
    charge: cardText(c.charge, 'See the case page.'),
    verdict: ruled ? VERDICT_LABELS[verdict] : 'Verdict pending',
    ruled,
    ruling: ruled ? excerpt(cardText(ruling, ''), RULING_EXCERPT_CHARS) : null,
    appeal: appealed ? (c.appealVerdict === c.verdict ? 'Upheld on appeal' : 'Overturned on appeal') : null,
    jury: jury.total ? juryLine(jury) : 'No jury votes yet',
    credit: `File your own case at ${excerpt(cardText(host, 'Group Chat Court'), HOST_MAX_CHARS)}`,
  };
}

/** A weak ETag for exactly what the card draws, so an unchanged card is never re-rendered. */
export function cardEtag(model) {
  const digest = createHash('sha256').update(JSON.stringify([CARD_VERSION, model])).digest('base64url');
  return `W/"${digest.slice(0, 27)}"`;
}

const el = (type, style, children) => ({ type, props: { style, children } });

// Block text that wraps long words and clamps to `lines` with an ellipsis.
const clamped = (lines, style, text) =>
  el('div', { display: 'block', lineClamp: lines, textOverflow: 'ellipsis', wordBreak: 'break-word', ...style }, text);

const label = (text) =>
  el('div', { display: 'flex', fontSize: 22, fontWeight: 700, letterSpacing: 4, color: COLORS.muted, marginBottom: 6 }, text);

/** Bigger type for short titles; every size fits its clamp in the same space. */
function titleStyle(length) {
  if (length <= 40) return [3, 76];
  if (length <= 90) return [3, 62];
  if (length <= 160) return [4, 50];
  return [5, 42];
}

/** The satori element tree for a card model. Text only goes in as children, never as markup. */
export function cardElement(model) {
  const [titleLines, titleSize] = titleStyle(model.title.length);
  const stampColor = model.ruled ? COLORS.accent : COLORS.muted;
  return el(
    'div',
    {
      display: 'flex',
      boxSizing: 'border-box',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      padding: 44,
      background: COLORS.paper,
      color: COLORS.ink,
      fontFamily: FONT_FAMILY,
    },
    el(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        border: `4px solid ${COLORS.ink}`,
        padding: '48px 60px',
      },
      [
        el('div', { display: 'flex', fontSize: 24, fontWeight: 700, letterSpacing: 6, color: COLORS.accent }, 'GROUP CHAT COURT'),
        clamped(titleLines, { fontSize: titleSize, fontWeight: 700, lineHeight: 1.15, marginTop: 18 }, model.title),
        el('div', { display: 'flex', height: 3, background: COLORS.ink, marginTop: 28, marginBottom: 24 }, ''),
        label('THE CHARGE'),
        clamped(3, { fontSize: 32, lineHeight: 1.3 }, model.charge),
        ...(model.appeal
          ? [el('div', { display: 'flex', fontSize: 26, fontWeight: 700, letterSpacing: 4, color: COLORS.accent, marginTop: 26 }, model.appeal.toUpperCase())]
          : []),
        el(
          'div',
          { display: 'flex', marginTop: model.appeal ? 10 : 34 },
          el(
            'div',
            {
              display: 'flex',
              border: `6px solid ${stampColor}`,
              borderRadius: 10,
              padding: '4px 26px',
              color: stampColor,
              fontSize: model.ruled ? 66 : 50,
              fontWeight: 700,
              letterSpacing: 2,
              transform: 'rotate(-3deg)',
            },
            model.verdict.toUpperCase(),
          ),
        ),
        clamped(
          // One line fewer under an appeal label, so the jury and the credit keep their place.
          model.appeal ? 6 : 7,
          { fontSize: 28, lineHeight: 1.4, marginTop: 30, color: model.ruled ? COLORS.ink : COLORS.muted },
          model.ruling ?? 'The judge rules once the defendant answers or the 24-hour deadline passes.',
        ),
        el(
          'div',
          { display: 'flex', flexDirection: 'column', marginTop: 'auto', paddingTop: 24 },
          [label('THE JURY'), el('div', { display: 'flex', fontSize: 40, fontWeight: 700 }, model.jury)],
        ),
        el(
          'div',
          {
            display: 'flex',
            justifyContent: 'space-between',
            borderTop: `2px solid ${COLORS.muted}`,
            marginTop: 26,
            paddingTop: 18,
            fontSize: 22,
            color: COLORS.muted,
          },
          [el('div', { display: 'flex' }, model.credit), el('div', { display: 'flex' }, 'Not legal advice.')],
        ),
      ],
    ),
  );
}

/**
 * The files the renderer needs, read from node_modules (Node, Vercel, Render): each wasm as bytes and each
 * font as `{ subset, weight, data }`. A Worker passes its own to setCardAssets: compiled wasm modules (both
 * initialisers take one) and the bundled font bytes.
 * @returns {Promise<{ resvgWasm: BufferSource | WebAssembly.Module, layoutWasm: BufferSource | WebAssembly.Module,
 *   fonts: { subset: string, weight: number, data: ArrayBuffer | Uint8Array }[] }>}
 */
async function readCardAssets() {
  const require = createRequire(import.meta.url);
  return {
    resvgWasm: readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')),
    layoutWasm: readFileSync(require.resolve('satori/layout.wasm')),
    fonts: fontFiles(require).map(([subset, weight, path]) => ({ subset, weight, data: readFileSync(path) })),
  };
}

let cardAssets = readCardAssets;
/** Replaces where the renderer's wasm and fonts come from; call before the first card. */
export function setCardAssets(load) {
  cardAssets = load;
}

let assets;
/** satori, resvg and the fonts, loaded once per process; a failure is retried on the next card. */
function loadAssets() {
  assets ??= (async () => {
    const [{ default: satori, init: initLayout }, { Resvg, initWasm }, files] = await Promise.all([
      import('satori/standalone'),
      import('@resvg/resvg-wasm'),
      cardAssets(),
    ]);
    const fonts = files.fonts.map(({ subset, weight, data }) => ({ name: `Lora-${subset}`, data, weight, style: 'normal' }));
    await initLayout(files.layoutWasm);
    // Last, because resvg's wasm can only be initialised once per process.
    await initWasm(files.resvgWasm);
    return { satori, Resvg, fonts };
  })().catch((error) => {
    assets = undefined;
    throw error;
  });
  return assets;
}

/**
 * @param {ReturnType<typeof cardModel>} model
 * @param {{ embedFont?: boolean }} [options]  embedFont: false keeps text as <text> (used by tests)
 */
export async function renderCardSvg(model, { embedFont = true } = {}) {
  const { satori, fonts } = await loadAssets();
  return satori(cardElement(model), { width: CARD_WIDTH, height: CARD_HEIGHT, fonts, embedFont });
}

/** @returns {Promise<Uint8Array>} the card as a PNG */
export async function renderCardPng(model) {
  return rasterise(await renderCardSvg(model));
}

/**
 * The share image of the public pages (og:image, twitter:image): the card's paper, ink and Lora, with the
 * product's pitch and a verdict stamp. Fixed text only, so it is drawn once per process.
 */
export function shareElement() {
  return el(
    'div',
    {
      display: 'flex',
      boxSizing: 'border-box',
      width: SHARE_IMAGE.width,
      height: SHARE_IMAGE.height,
      padding: 36,
      background: COLORS.paper,
      color: COLORS.ink,
      fontFamily: FONT_FAMILY,
    },
    el(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        border: `4px solid ${COLORS.ink}`,
        padding: '44px 56px',
      },
      [
        el('div', { display: 'flex', fontSize: 24, fontWeight: 700, letterSpacing: 6, color: COLORS.accent }, 'GROUP CHAT COURT'),
        el('div', { display: 'flex', fontSize: 92, fontWeight: 700, lineHeight: 1.1, marginTop: 16 }, 'Settle it in court.'),
        el('div', { display: 'flex', height: 3, width: 220, background: COLORS.ink, marginTop: 26, marginBottom: 22 }, ''),
        el(
          'div',
          { display: 'block', fontSize: 34, lineHeight: 1.35, maxWidth: 860 },
          'File a petty case, summon the other side, let your friends be the jury, and let an AI judge rule.',
        ),
        el(
          'div',
          { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 'auto' },
          [
            el('div', { display: 'flex', fontSize: 24, color: COLORS.muted }, 'Free to file · Appeal $3 · Not legal advice'),
            el(
              'div',
              {
                display: 'flex',
                border: `6px solid ${COLORS.accent}`,
                borderRadius: 10,
                padding: '2px 24px',
                color: COLORS.accent,
                fontSize: 60,
                fontWeight: 700,
                letterSpacing: 2,
                transform: 'rotate(-6deg)',
              },
              'GUILTY',
            ),
          ],
        ),
      ],
    ),
  );
}

let sharePng;
/** @returns {Promise<Uint8Array>} the share image as a PNG, drawn once per process (a failure is retried) */
export function renderSharePng() {
  sharePng ??= (async () => {
    const { satori, fonts } = await loadAssets();
    const svg = await satori(shareElement(), { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height, fonts });
    return rasterise(svg);
  })().catch((error) => {
    sharePng = undefined;
    throw error;
  });
  return sharePng;
}

/** An SVG from satori as a PNG at its own size. */
async function rasterise(svg) {
  const { Resvg } = await loadAssets();
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
