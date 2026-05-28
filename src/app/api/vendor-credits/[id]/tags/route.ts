import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { orderTagsPatchSchema } from '@/lib/validation/orderTags';
import { setVendorCreditTags } from '@/server/services/orderTags';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requirePermission(req, 'bills.create');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = orderTagsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const tags = await setVendorCreditTags(db, id, parsed.data, auditCtx);
    return NextResponse.json({
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
