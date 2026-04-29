import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getWarehouse } from '@/server/services/warehouse';
import { listInventoryByWarehouse } from '@/server/services/inventory';

type Ctx = { params: Promise<{ warehouseId: string }> };

const MAX_TAKE = 500;

export async function GET(req: Request, ctx: Ctx) {
  const { warehouseId } = await ctx.params;
  const url = new URL(req.url);
  const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0);
  const takeRaw = Number(url.searchParams.get('take') ?? 100) || 100;
  const take = Math.min(MAX_TAKE, Math.max(1, takeRaw));

  const warehouse = await getWarehouse(db, warehouseId);
  if (!warehouse) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const inventory = await listInventoryByWarehouse(db, warehouseId, {
      skip,
      take,
    });
    return NextResponse.json({ inventory });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
