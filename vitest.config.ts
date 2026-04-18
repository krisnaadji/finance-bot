import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in `tests/` at the repo root so `src/` stays pure-production.
    // tsconfig's rootDir is `./src`, so putting tests outside keeps tsc build
    // output clean.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Don't burn the user's Gemini quota: no tests hit real APIs. All
    // external services (supabase, gemini, whatsapp) must be mocked.
    globals: false,
    // Each test file gets a fresh module graph so vi.mock from one file
    // doesn't leak into another.
    isolate: true,
  },
});
