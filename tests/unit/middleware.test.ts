import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

// Edge middleware tests. The middleware is a presence check on the
// session cookie + an explicit deny on /api/auth/sign-up. It does NOT
// validate the cookie's signature — that's slice B's requireAuth job
// at the route handler. These tests pin the routing decisions.

const SESSION_COOKIE = 'better-auth.session_token';

function req(path: string, opts: { withSession?: boolean } = {}): NextRequest {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers();
  if (opts.withSession) {
    headers.set('cookie', `${SESSION_COOKIE}=stub-token-value`);
  }
  return new NextRequest(url, { headers });
}

describe('middleware — public path allowlist', () => {
  it('lets the root path through without a session', () => {
    const res = middleware(req('/'));
    expect(res?.status).toBe(200);
  });

  it('lets /login through without a session', () => {
    const res = middleware(req('/login'));
    expect(res?.status).toBe(200);
  });

  it('lets /api/auth/* through without a session (except sign-up)', () => {
    const res = middleware(req('/api/auth/sign-in/email'));
    expect(res?.status).toBe(200);
  });

  it('lets /api/health through without a session', () => {
    const res = middleware(req('/api/health'));
    expect(res?.status).toBe(200);
  });
});

describe('middleware — always-deny prefixes', () => {
  it('returns 404 for /api/auth/sign-up even with a session', () => {
    const res = middleware(req('/api/auth/sign-up/email', { withSession: true }));
    expect(res?.status).toBe(404);
  });

  it('returns 404 for /api/auth/sign-up without a session', () => {
    const res = middleware(req('/api/auth/sign-up/email'));
    expect(res?.status).toBe(404);
  });
});

describe('middleware — gated paths without session', () => {
  it('returns 401 JSON for /api/* without a session', () => {
    const res = middleware(req('/api/customers'));
    expect(res?.status).toBe(401);
  });

  it('redirects to /login for non-API paths without a session', () => {
    const res = middleware(req('/dashboard/customers'));
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toContain('/login');
  });

  it('appends ?next=<original-path> to the login redirect', () => {
    const res = middleware(req('/dashboard/orders/123'));
    const loc = res?.headers.get('location');
    expect(loc).toBeTruthy();
    expect(loc).toContain('next=%2Fdashboard%2Forders%2F123');
  });

  it('preserves query string in the next= param', () => {
    const r = req('/dashboard/orders');
    // Mutate the URL to add a query string (NextRequest doesn't accept it via headers).
    const url = new URL(r.url);
    url.searchParams.set('view', 'open');
    const r2 = new NextRequest(url, { headers: r.headers });
    const res = middleware(r2);
    const loc = res?.headers.get('location');
    expect(loc).toContain('view%3Dopen');
  });
});

describe('middleware — gated paths with session cookie present', () => {
  it('lets /api/* through when the session cookie is present', () => {
    const res = middleware(req('/api/customers', { withSession: true }));
    expect(res?.status).toBe(200);
  });

  it('lets dashboard pages through when the session cookie is present', () => {
    const res = middleware(req('/dashboard/customers', { withSession: true }));
    expect(res?.status).toBe(200);
  });
});
