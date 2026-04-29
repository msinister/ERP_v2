import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelPurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import { cancelPurchaseOrder } from '@/server/services/purchaseOrders';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = cancelPurchaseOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const po = await cancelPurchaseOrder(db, id, parsed.data);
    return NextResponse.json(po);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
