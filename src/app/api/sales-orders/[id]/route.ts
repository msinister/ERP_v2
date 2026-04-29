import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateSalesOrderInputSchema } from '@/lib/validation/sales';
import {
  getSalesOrder,
  softDeleteSalesOrder,
  updateSalesOrder,
} from '@/server/services/salesOrders';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const so = await getSalesOrder(db, id);
  if (!so) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(so);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updateSalesOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const so = await updateSalesOrder(db, id, parsed.data);
    return NextResponse.json(so);
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
    const so = await softDeleteSalesOrder(db, id);
    return NextResponse.json(so);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
