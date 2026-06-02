import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { auth } from '@/lib/auth/auth';

// DELETE /api/me/sessions/[id] — revoke a specific session by its ID.
// Verifies the session belongs to the current user and is not the active session.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req);
    const { id } = await params;

    // Verify session belongs to this user
    const session = await db.session.findFirst({
      where: { id, userId: user.id },
      select: { id: true, token: true },
    });
    if (!session) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Prevent revoking the current session via this endpoint (use logout instead)
    const current = await auth.api.getSession({ headers: req.headers });
    if (current?.session.id === id) {
      return NextResponse.json({ error: 'cannot_revoke_current_session' }, { status: 400 });
    }

    // Use BetterAuth's revoke so the session.delete.after hook fires (LOGOUT audit)
    await auth.api.revokeSession({
      body: { token: session.token },
      headers: req.headers,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
