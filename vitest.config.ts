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
      // runs (2026-11-22, at the end of the 0.6.0 work: statements 94.64, branches 87.26,
      // functions 95.21, lines 96.75). It is there to catch a change that arrives without tests,
      // not to be chased upward.
      //
      // What runs in a child process is not counted here, and that is most of what is missing:
      // the signal handlers and `main` in `src/server/index.ts` are exercised by tests that start
      // the real server, so that file reads as 60% of its functions. The first floor was measured
      // before those existed and was not measured again when they landed — it failed CI's own
      // command with the suite green. A floor is re-measured in the commit that moves it.
      thresholds: { statements: 93, branches: 86, functions: 94, lines: 95 },
    },
  },
});
