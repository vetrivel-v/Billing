import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/generated/**',
        // Test infrastructure; exercised by the integration run in a separate process.
        'packages/test-utilities/**',
        // Scripted API stand-in for component tests; not application code.
        'apps/web/src/test-support/**',
        '**/*.test.*',
        'apps/*/src/main.ts*',
        'apps/desktop/src/preload.ts',
        // Electron windows and dialogs: verified by the Electron smoke check that renders a real PDF.
        'apps/desktop/src/electron-document.ts',
      ],
      // Phase 0 has little logic; thresholds are set on what exists and will be raised per phase.
      // They must never be lowered to make a failing run pass (spec section 41).
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // The unit suite now includes many jsdom component tests that run in parallel; a 5 s default made two API
          // tests time out once under whole-suite load (they pass alone and on re-run). Assertions are unchanged.
          testTimeout: 15_000,
          include: [
            'packages/**/*.test.{ts,tsx}',
            'apps/**/*.test.{ts,tsx}',
            'tests/unit/**/*.test.ts',
            'tests/security/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.int.test.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['tests/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
