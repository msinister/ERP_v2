import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apBalanceForVendor } from '@/server/services/ap';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get('asOf');
    const asOf = asOfParam ? new Date(asOfParam) : new Date();
    const result = await apBalanceForVendor(db, id, asOf);
    return NextResponse.json({
      vendorId: id,
      asOf: asOf.toISOString(),
      apBalance: result.apBalance.toString(),
      unappliedCreditBalance: result.unappliedCreditBalance.toString(),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
