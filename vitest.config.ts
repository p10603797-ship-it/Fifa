import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV_BUILD__: 'true',
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 120_000,
    pool: 'threads',
    // Many agents share a 4-CPU container: keep each vitest run small.
    maxWorkers: 2,
  },
});
