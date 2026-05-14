import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setPrimaryVendorForVariant } from '@/server/services/vendorProducts';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; pid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { pid } = await ctx.params;
    const product = await setPrimaryVendorForVariant(db, pid, auditCtx);
    return NextResponse.json(product);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
