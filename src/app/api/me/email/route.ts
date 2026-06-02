import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { audit } from '@/lib/audit/audit';
import { AuditAction } from '@/generated/tenant';

const bodySchema = z.object({
  email: z.string().email('Must be a valid email').max(255),
});

export async function PUT(req: Request) {
  try {
    const user = await requireAuth(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const newEmail = parsed.data.email.toLowerCase().trim();

    if (newEmail === user.email.toLowerCase()) {
      return NextResponse.json({ ok: true });
    }

    const existing = await db.user.findFirst({
      where: { email: { equals: newEmail, mode: 'insensitive' }, NOT: { id: user.id } },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ error: 'email_taken' }, { status: 409 });
    }

    await db.user.update({
      where: { id: user.id },
      data: { email: newEmail, emailVerified: false },
    });

    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: user.id,
      before: { email: user.email },
      after: { email: newEmail },
      ctx: auditCtxFromRequest(req, user),
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
