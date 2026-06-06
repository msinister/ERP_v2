import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setDefaultAddress } from '@/server/services/customerAddresses';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string; aid: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { aid } = await ctx.params;
    const address = await setDefaultAddress(db, aid, auditCtx);
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
