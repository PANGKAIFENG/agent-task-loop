import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 10_000,
  },
});
