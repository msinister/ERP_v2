import { NextResponse, type NextRequest } from 'next/server';

// =============================================================================
// Edge middleware — global auth gate.
//
// Strategy: cookie-presence check only. The actual session validation
// (signature verification, expiry, user-enabled) happens at the route /
// page boundary via getCurrentUser() — that's where we have access to
// the database adapter and full BetterAuth runtime. The middleware's
// job is to short-circuit unauthenticated traffic so we don't spin up
// route handlers we'll just 401 from.
//
// PUBLIC PATHS (allowed without a session):
//   - /api/auth/*   BetterAuth's own endpoints (sign-in, sign-out, etc.)
//   - /login        the minimal login form
//   - / (root)      lands on a future marketing/landing page or redirects
//                   to /dashboard or /login depending on session state;
//                   keep it public so unauthenticated users can reach it
//                   without a redirect loop.
//   - /api/health   reserved for future health-check; no session required
//
// EVERYTHING ELSE under /api/* and /(dashboard)/* requires a session
// cookie. API routes get a 401 JSON; page routes get a 302 to /login.
//
// SECURITY NOTE: a forged cookie name will pass this middleware but
// fail at getCurrentUser() — BetterAuth verifies the signed token via
// `auth.api.getSession()`. The middleware is NOT the security boundary
// for unauthenticated access — it's a fast-path optimization plus a
// UX redirect. Slice B's requireAuth() is the real gate.
// =============================================================================

const PUBLIC_PATHS = ['/login', '/api/health'];
const PUBLIC_PREFIXES = ['/api/auth/', '/_next/', '/favicon'];

// Closed at the edge regardless of session state. The public sign-up
// endpoint must never be reachable: pilot user provisioning is done by
// the bootstrap script and (post-pilot) by Super Admins through an
// authenticated admin route. Internal server callers go through
// auth.api.signUpEmail directly and don't traverse middleware.
const ALWAYS_DENY_PREFIXES = ['/api/auth/sign-up'];

// BetterAuth uses the cookie name "<prefix>.session_token". The default
// prefix is "better-auth"; we don't override `cookiePrefix` so this is
// the literal cookie name we look for. If the prefix changes in
// auth.ts, update this constant in lockstep.
const SESSION_COOKIE_NAME = 'better-auth.session_token';

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (ALWAYS_DENY_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.json(
      { error: 'not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // A presence check is sufficient at the edge — the cookie is signed
  // and validated by BetterAuth at the route handler. If absent, gate.
  const hasSession = req.cookies.has(SESSION_COOKIE_NAME);
  if (hasSession) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

// Matcher: run on everything except Next.js internals + static assets.
// We re-check the prefix list inside the handler too (defense in
// depth — matcher syntax has surprising edge cases with optional
// segments and rewrites).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
