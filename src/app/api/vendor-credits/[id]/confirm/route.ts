import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { confirmVendorCredit } from '@/server/services/vendorCredits';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission(req, 'bills.confirm');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const vc = await confirmVendorCredit(db, id, auditCtx);
    return NextResponse.json(vc);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
