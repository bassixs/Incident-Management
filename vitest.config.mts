import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup-env.ts'],
    globals: false,
    testTimeout: 20000,
    pool: 'threads',
    // Integration files reset the same incident_test database. Concurrency is
    // exercised inside scenarios; running their files together corrupts fixtures.
    fileParallelism: false,
  },
});
