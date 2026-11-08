// The Cloudflare Worker: wrangler.jsonc, the fonts src/worker.js bundles, and the wasm src/harfbuzz-wasm.js swaps
// in for satori. The Worker itself only runs in workerd (it imports .wasm modules); its pieces are checked here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FONT_SUBSETS } from '../src/card.js';
import { EXPIRY_CRON } from '../src/schedule.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const source = (path) => read(path).toString('utf8');

// wrangler.jsonc → JSON: drops // and /* */ comments outside strings, and trailing commas.
function parseJsonc(text) {
  let out = '';
  for (let i = 0, inString = false; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('wrangler.jsonc', () => {
  const config = parseJsonc(source('wrangler.jsonc'));

  it('names the Worker after the repo, runs src/worker.js, and has no build step (the deploy broker refuses one)', () => {
    expect(config.name).toBe('pettycourt');
    expect(config.main).toBe('src/worker.js');
    expect(config.build).toBeUndefined();
    expect(config.compatibility_flags).toContain('nodejs_compat');
  });

  it('is production on its own workers.dev address: links there, launch counts on', () => {
    expect(config.vars.PUBLIC_URL).toBe('https://pettycourt.1426davejobs.workers.dev');
    expect(config.vars.NEXT_PUBLIC_DEPLOY_ENV).toBe('production');
  });

  it('bundles the fonts as bytes, and runs the expiry on its schedule', () => {
    expect(config.rules.some((rule) => rule.type === 'Data' && rule.globs.includes('**/*.woff2'))).toBe(true);
    expect(config.triggers.crons).toEqual([EXPIRY_CRON]);
  });
});

describe('src/worker.js', () => {
  it('bundles both weights of every font subset card.js draws with', () => {
    const worker = source('src/worker.js');
    for (const subset of FONT_SUBSETS) {
      for (const weight of [400, 700]) {
        const name = `${subset.replace(/-(\w)/, (_, ch) => ch.toUpperCase())}${weight}`;
        expect(worker).toContain(`import ${name} from '@fontsource/lora/files/lora-${subset}-${weight}-normal.woff2';`);
        expect(worker).toContain(`{ subset: '${subset}', weight: ${weight}, data: ${name} }`);
      }
    }
  });

  it('loads the wasm swaps before anything that imports satori', () => {
    const imports = source('src/worker.js').match(/^import .*$/gm);
    expect(imports[0]).toBe("import './harfbuzz-wasm.js';");
  });
});

describe('satori on a Worker (src/harfbuzz-wasm.js)', () => {
  const shim = source('src/harfbuzz-wasm.js');

  it("satori's inline harfbuzz wasm is harfbuzzjs/hb.wasm byte for byte, of the size the Worker matches on", () => {
    const satori = readFileSync(new URL('../node_modules/satori/dist/standalone.js', import.meta.url), 'utf8');
    const blobs = satori.match(/[A-Za-z0-9+/=]{20000,}/g) ?? [];
    expect(blobs).toHaveLength(1);
    const hb = readFileSync(new URL('../node_modules/harfbuzzjs/hb.wasm', import.meta.url));
    expect(Buffer.from(blobs[0], 'base64').equals(hb)).toBe(true);
    expect(Number(shim.match(/HARFBUZZ_WASM_BYTES = (\d+);/)[1])).toBe(hb.length);
  });

  it('every module a card render compiles from bytes is one the Worker has precompiled', async () => {
    const bundled = shim.match(/CALLBACK_VI_HEX = '([0-9a-f]+)'/)[1];
    expect(read('src/harfbuzz-callback-vi.wasm').toString('hex')).toBe(bundled);

    // Record what's compiled from bytes, then load satori (fresh in this test file) and render.
    const compiled = new Set();
    const Module = WebAssembly.Module;
    function Recording(bytes) {
      compiled.add(Buffer.from(ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes).toString('hex'));
      return new Module(bytes);
    }
    Recording.prototype = Module.prototype;
    Object.setPrototypeOf(Recording, Module);
    WebAssembly.Module = Recording;
    try {
      const { renderCardPng, renderSharePng, cardModel } = await import('../src/card.js');
      const at = new Date('2026-11-01T12:00:00Z');
      const ruled = {
        id: 'AAAAAAAAAAAAAAAA',
        title: 'The Shower Affair: Ünïcödé, Привет, Việt',
        charge: 'Said "five minutes away" while still in the shower',
        verdict: 'guilty',
        ruling: 'The court finds the defendant guilty of optimistic time estimates. '.repeat(4),
        defaultJudgment: null,
        ruledAt: at,
        declinedAt: null,
        createdAt: at,
      };
      await renderCardPng(cardModel(ruled, { guilty: 2, notGuilty: 1, total: 3 }, 'pettycourt.example'));
      await renderSharePng();
    } finally {
      WebAssembly.Module = Module;
    }
    expect(compiled.size).toBeGreaterThan(0); // the recording saw satori load; otherwise this proves nothing
    expect([...compiled]).toEqual([bundled]);
  });
});
