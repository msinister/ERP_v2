import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// GET /api/me/sessions — list all active sessions for the current user.
// The "current" session is identified by comparing session IDs.
export async function GET(req: Request) {
  try {
    const user = await requireAuth(req);

    // Get the current session to mark it
    const current = await auth.api.getSession({ headers: req.headers });
    const currentSessionId = current?.session.id ?? null;

    const sessions = await db.session.findMany({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      sessions: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === currentSessionId,
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// DELETE /api/me/sessions — revoke all sessions except the current one.
export async function DELETE(req: Request) {
  try {
    await requireAuth(req);
    await auth.api.revokeOtherSessions({ headers: req.headers });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
