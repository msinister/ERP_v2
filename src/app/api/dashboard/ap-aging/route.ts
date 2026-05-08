import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apAgingWidget } from '@/server/services/reports/dashboard';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get('asOf');
    const asOf = asOfParam ? new Date(asOfParam) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      return NextResponse.json({ error: 'invalid asOf' }, { status: 400 });
    }
    const widget = await apAgingWidget(db, asOf);
    return NextResponse.json({
      current: widget.current.toString(),
      b1to30: widget.b1to30.toString(),
      b31to60: widget.b31to60.toString(),
      b61to90: widget.b61to90.toString(),
      b91plus: widget.b91plus.toString(),
      total: widget.total.toString(),
      vendorCount: widget.vendorCount,
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
