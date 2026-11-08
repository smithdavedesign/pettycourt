// Worker only (imported first by src/worker.js, before satori loads). satori shapes text with harfbuzz, built
// with emscripten, and a Worker can't compile wasm at run time (workerd refuses), so two compiles are swapped
// for modules wrangler compiled at deploy. Without them, satori's renders waited forever.
//   - harfbuzz itself: satori carries it as inline bytes for WebAssembly.instantiate. The same binary ships as
//     harfbuzzjs/hb.wasm (satori's own pinned dependency), handed over for bytes of exactly its size.
//   - Its JS callbacks: emscripten's addFunction wraps a JS function in a tiny module it compiles with
//     `new WebAssembly.Module`, whose bytes depend only on the signature. harfbuzzjs registers one at init (its
//     "vi" free callback); src/harfbuzz-callback-vi.wasm is that module, matched byte for byte.
// test/worker.test.js renders a card under Node, records every module compiled from bytes, and checks each is
// one of these, so a satori upgrade that needs another fails a test, not production.
import harfbuzz from 'harfbuzzjs/hb.wasm';
import callbackVi from './harfbuzz-callback-vi.wasm';

// hb.wasm's size in bytes (harfbuzzjs 0.10.0, pinned by satori). Nothing from satori is imported here: this must
// run before it loads.
const HARFBUZZ_WASM_BYTES = 381964;
// The bytes of src/harfbuzz-callback-vi.wasm, as emscripten generates them.
const CALLBACK_VI_HEX = '0061736d01000000018700016081007f800002070101650166000007050101660000';

const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  if (!(source instanceof WebAssembly.Module) && source?.byteLength === HARFBUZZ_WASM_BYTES) {
    return instantiate.call(WebAssembly, harfbuzz, imports).then((instance) => ({ module: harfbuzz, instance }));
  }
  return instantiate.call(WebAssembly, source, imports);
};

const hex = (bytes) => [...new Uint8Array(ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
const Module = WebAssembly.Module;
function PrecompiledModule(bytes) {
  if (bytes?.byteLength === CALLBACK_VI_HEX.length / 2 && hex(bytes) === CALLBACK_VI_HEX) return callbackVi;
  return new Module(bytes);
}
// Still the same class to everyone else: instanceof, Module.exports() and the other statics keep working.
PrecompiledModule.prototype = Module.prototype;
Object.setPrototypeOf(PrecompiledModule, Module);
WebAssembly.Module = PrecompiledModule;
