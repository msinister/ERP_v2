import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { audit } from '@/lib/audit/audit';
import { AuditAction } from '@/generated/tenant';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';

// Max ~400 KB base64 (≈ 300 KB raw image), well within DB row limits.
const MAX_DATA_URL_BYTES = 512_000;

const bodySchema = z.object({
  dataUrl: z
    .string()
    .startsWith('data:image/', 'Must be an image data URL')
    .max(MAX_DATA_URL_BYTES, 'Image is too large (max ~300 KB)'),
});

export async function POST(req: Request) {
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
      select: { image: true },
    });

    await db.user.update({
      where: { id: user.id },
      data: { image: parsed.data.dataUrl },
    });

    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: user.id,
      before: { image: before?.image ? '[set]' : null },
      after: { image: '[updated]' },
      ctx: auditCtxFromRequest(req, user),
    });

    return NextResponse.json({ ok: true, dataUrl: parsed.data.dataUrl });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

// Remove avatar
export async function DELETE(req: Request) {
  try {
    const user = await requireAuth(req);

    await db.user.update({
      where: { id: user.id },
      data: { image: null },
    });

    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: user.id,
      before: { image: '[set]' },
      after: { image: null },
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
