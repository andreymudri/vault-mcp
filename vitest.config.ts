import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // A floor one point under what was measured when coverage was first turned on (2026-11-22:
      // statements 95.58, branches 87.26, functions 97.92, lines 97.51). It is there to catch a
      // change that arrives without tests, not to be chased upward. The two cross-process test
      // files start real child processes, and what runs in a child is not counted here.
      thresholds: { statements: 94, branches: 86, functions: 96, lines: 96 },
    },
  },
});
