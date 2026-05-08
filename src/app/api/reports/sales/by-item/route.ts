import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { salesByItem } from '@/server/services/reports/operational';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if (!toParam) {
      return NextResponse.json({ error: 'to parameter is required' }, { status: 400 });
    }
    const from = fromParam ? new Date(fromParam) : undefined;
    const to = new Date(toParam);
    if (Number.isNaN(to.getTime()) || (from && Number.isNaN(from.getTime()))) {
      return NextResponse.json({ error: 'invalid date parameter' }, { status: 400 });
    }
    const report = await salesByItem(db, { from, to });
    return NextResponse.json({
      asOfFrom: report.asOfFrom?.toISOString() ?? null,
      asOfTo: report.asOfTo.toISOString(),
      rows: report.rows.map((r) => ({
        variantId: r.variantId,
        sku: r.sku,
        name: r.name,
        qtySold: r.qtySold.toString(),
        grossSales: r.grossSales.toString(),
      })),
      totalQty: report.totalQty.toString(),
      totalGrossSales: report.totalGrossSales.toString(),
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
