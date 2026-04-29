import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelSalesOrderInputSchema } from '@/lib/validation/sales';
import { cancelSalesOrder } from '@/server/services/salesOrders';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = cancelSalesOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const so = await cancelSalesOrder(db, id, parsed.data);
    return NextResponse.json(so);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
