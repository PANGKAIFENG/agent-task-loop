import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve('tests/helpers/obsidian-runtime.ts'),
    },
  },
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 10_000,
  },
});
