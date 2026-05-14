import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setDefaultVendorAddress } from '@/server/services/vendorAddresses';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; aid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { aid } = await ctx.params;
    const address = await setDefaultVendorAddress(db, aid, auditCtx);
    return NextResponse.json(address);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
