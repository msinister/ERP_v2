import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setPreferred } from '@/server/services/customerPaymentMethods';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { pmid } = await ctx.params;
    const pm = await setPreferred(db, pmid, auditCtx);
    return NextResponse.json(pm);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
