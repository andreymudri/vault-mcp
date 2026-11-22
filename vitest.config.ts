import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // A floor one point under what `npm test -- --coverage` measures, which is the command CI
      // runs (2026-11-22, at the end of the 0.6.0 work: statements 95.4, branches 87.75,
      // functions 96.97, lines 97.39). It is there to catch a change that arrives without tests,
      // not to be chased upward.
      //
      // What runs in a child process is not counted here: `main` in `src/server/index.ts`, and
      // whatever only the tests that start a real server reach. The first floor was measured
      // before code like that existed and not again when it landed, and it failed CI's own
      // command with the suite green. A floor is re-measured in the commit that moves it.
      thresholds: { statements: 94, branches: 86, functions: 95, lines: 96 },
    },
  },
});
