import { NextResponse } from 'next/server';

// =============================================================================
// AuthError — thrown by requireAuth / requireSuperAdmin to signal a
// missing or insufficient session. Route handlers convert it to a JSON
// response via authErrorResponse(). Keeping the throw + map pattern
// (rather than returning a NextResponse from the helper) lets route
// handlers stay linear: `const user = await requireAuth(req)` reads
// like an assertion, not a branch.
// =============================================================================

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export function authErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof AuthError) {
    return NextResponse.json(
      { error: e.message },
      { status: e.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}
