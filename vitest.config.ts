import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
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
