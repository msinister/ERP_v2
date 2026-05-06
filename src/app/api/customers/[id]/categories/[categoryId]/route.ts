import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { unassignCategory } from '@/server/services/customerCategories';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; categoryId: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, categoryId } = await ctx.params;
    const result = await unassignCategory(db, id, categoryId, auditCtx);
    return NextResponse.json(result);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
