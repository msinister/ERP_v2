import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { confirmPurchaseOrder } from '@/server/services/purchaseOrders';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const po = await confirmPurchaseOrder(db, id);
    return NextResponse.json(po);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
