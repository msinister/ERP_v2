import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { unassignTag } from '@/server/services/customerTags';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; tagLabel: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, tagLabel } = await ctx.params;
    const result = await unassignTag(db, id, decodeURIComponent(tagLabel), auditCtx);
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
