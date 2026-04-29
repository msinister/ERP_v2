import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { dispatchSalesOrder } from '@/server/services/salesOrders';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const so = await dispatchSalesOrder(db, id);
    return NextResponse.json(so);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
