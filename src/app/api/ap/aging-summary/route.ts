import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apAgingSummary } from '@/server/services/ap';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get('asOf');
    const asOf = asOfParam ? new Date(asOfParam) : new Date();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 500);
    const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
    const rows = await apAgingSummary(db, asOf, { limit, offset });
    return NextResponse.json({
      asOf: asOf.toISOString(),
      rows: rows.map((r) => ({
        vendorId: r.vendorId,
        vendorCode: r.vendorCode,
        vendorName: r.vendorName,
        current: r.current.toString(),
        b1to30: r.b1to30.toString(),
        b31to60: r.b31to60.toString(),
        b61to90: r.b61to90.toString(),
        b91plus: r.b91plus.toString(),
        total: r.total.toString(),
        unappliedCreditBalance: r.unappliedCreditBalance.toString(),
      })),
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
