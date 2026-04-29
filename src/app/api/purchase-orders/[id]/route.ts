import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updatePurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import {
  getPurchaseOrder,
  softDeletePurchaseOrder,
  updatePurchaseOrder,
} from '@/server/services/purchaseOrders';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const po = await getPurchaseOrder(db, id);
  if (!po) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(po);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updatePurchaseOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const po = await updatePurchaseOrder(db, id, parsed.data);
    return NextResponse.json(po);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const po = await softDeletePurchaseOrder(db, id);
    return NextResponse.json(po);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
