import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // PGlite boots a WASM Postgres per test file; give hooks room on slow machines.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
