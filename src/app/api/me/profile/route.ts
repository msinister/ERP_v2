import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { audit } from '@/lib/audit/audit';
import { AuditAction } from '@/generated/tenant';

const bodySchema = z.object({
  name: z.string().min(1, 'Required').max(255),
  phone: z.string().max(50).nullish(),
  title: z.string().max(255).nullish(),
  department: z.string().max(255).nullish(),
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

    const before = await db.user.findUnique({
      where: { id: user.id },
      select: { name: true, phone: true, title: true, department: true },
    });

    const after = {
      name: parsed.data.name,
      phone: parsed.data.phone ?? null,
      title: parsed.data.title ?? null,
      department: parsed.data.department ?? null,
    };

    await db.user.update({
      where: { id: user.id },
      data: after,
    });

    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: user.id,
      before,
      after,
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
