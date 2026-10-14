import { defineConfig } from 'vitest/config';
export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.db.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
