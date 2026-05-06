// Vitest global setup file. Wired via setupFiles in vitest.config.ts so
// it runs BEFORE any test module is imported — necessary because
// src/lib/crypto/index.ts validates TENANT_FIELD_ENCRYPTION_KEY at module
// load. A per-file beforeAll() would run too late to satisfy that.
//
// THIS KEY IS FOR TESTS ONLY. It is a fixed deterministic value so every
// test run produces consistent ciphertexts when needed and so the helper
// loads cleanly during local + CI runs. It must NEVER appear in any
// production-facing config, secret store, or .env.production. Production
// uses a real 32-byte key from the per-instance secrets store.

if (!process.env.TENANT_FIELD_ENCRYPTION_KEY) {
  // 32 bytes of zeros, base64-encoded. Deterministic on purpose; if a
  // test relies on a specific key, it overrides this value in its own
  // setup. The real production key is generated via:
  //   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
  process.env.TENANT_FIELD_ENCRYPTION_KEY =
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
}

// BetterAuth requires both a secret (>=32 chars) and a base URL at
// module-load time. Same rationale as the encryption key above:
// deterministic test values so importing src/lib/auth/auth.ts works
// in any test that touches it (directly or transitively).
if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET =
    'test-better-auth-secret-deterministic-do-not-use-in-prod-32+chars';
}
if (!process.env.BETTER_AUTH_URL) {
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
}
