import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    // File-level serial execution. The integration suite shares a single
    // real Postgres DB across all test files; with parallel file execution
    // (vitest's default), files that mutate the same singleton rows
    // (e.g. Setting rows used by multiple suites) race and produce flaky
    // setSetting → getSetting round-trips. Production helpers like
    // getRestockingFeeDefault must read the literal singleton key, so
    // test isolation via unique-per-file keys isn't possible. Diagnosed
    // across two sessions of Phase 1A/1B; see commit message for context.
    fileParallelism: false,
    // Order matters: setupGlobalEnv runs first to install
    // TENANT_FIELD_ENCRYPTION_KEY before any test module loads
    // src/lib/crypto/index.ts (which validates the key at module load).
    setupFiles: ['./tests/helpers/setupGlobalEnv.ts', './tests/helpers/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
