import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { inventoryValuation } from '@/server/services/reports/operational';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const warehouseId = url.searchParams.get('warehouseId') ?? undefined;
    const report = await inventoryValuation(db, { warehouseId });
    return NextResponse.json({
      warehouseId: report.warehouseId,
      rows: report.rows.map((r) => ({
        variantId: r.variantId,
        sku: r.sku,
        name: r.name,
        warehouseId: r.warehouseId,
        warehouseCode: r.warehouseCode,
        qty: r.qty.toString(),
        value: r.value.toString(),
      })),
      totalQty: report.totalQty.toString(),
      totalValue: report.totalValue.toString(),
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
