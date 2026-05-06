import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// =============================================================================
// Static-analysis sweep: every /api/*/route.ts must call requireAuth (or
// requireSuperAdmin). The single exception is BetterAuth's catch-all
// handler at /api/auth/[...all]/route.ts which deliberately stays
// reachable without a session — it's where users sign in.
//
// This test runs in milliseconds and catches the regression where someone
// adds a new API route and forgets to gate it. The auth boundary is too
// important to leave to manual review.
// =============================================================================

const API_ROOT = join(process.cwd(), 'src', 'app', 'api');

// Routes intentionally exempt from the auth requirement. Every entry
// must justify itself in a comment — adding to this list is a security
// decision, not a workaround.
const ALLOWED_UNAUTHENTICATED: ReadonlyArray<string> = [
  // BetterAuth's own endpoints (sign-in, sign-out, get-session, etc.).
  // Sign-in endpoints by definition cannot require an existing session.
  // The /api/auth/sign-up sub-path is closed at the edge by middleware.
  // Path is relative to src/app/api/ so it does NOT carry an `api/` prefix.
  ['auth', '[...all]', 'route.ts'].join(sep),
];

function walkRoutes(dir: string): string[] {
  const entries = readdirSync(dir);
  const result: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...walkRoutes(full));
    } else if (entry === 'route.ts') {
      result.push(full);
    }
  }
  return result;
}

describe('Route handlers — auth coverage', () => {
  const routeFiles = walkRoutes(API_ROOT);

  it('finds the expected number of route files (smoke check)', () => {
    // A surprisingly low or high count signals filesystem changes that
    // warrant a glance — adjust the bounds if the API surface grows.
    expect(routeFiles.length).toBeGreaterThan(50);
    expect(routeFiles.length).toBeLessThan(200);
  });

  for (const file of routeFiles) {
    const relativePath = file.slice(API_ROOT.length + 1);
    const isAllowedUnauthenticated = ALLOWED_UNAUTHENTICATED.some(
      (p) => relativePath === p,
    );

    if (isAllowedUnauthenticated) {
      it(`${relativePath} — exempt from auth (BetterAuth handler)`, () => {
        // Existence assertion only; no requireAuth call expected.
        const contents = readFileSync(file, 'utf8');
        expect(contents.length).toBeGreaterThan(0);
      });
      continue;
    }

    it(`${relativePath} — calls requireAuth or requireSuperAdmin`, () => {
      const contents = readFileSync(file, 'utf8');
      const hasAuthCall =
        /\b(requireAuth|requireSuperAdmin)\s*\(/.test(contents);
      expect(hasAuthCall, `route handler must gate via requireAuth or requireSuperAdmin`).toBe(
        true,
      );
    });
  }
});
