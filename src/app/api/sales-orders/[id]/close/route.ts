import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { closeSalesOrderInputSchema } from '@/lib/validation/sales';
import { closeSalesOrder } from '@/server/services/salesOrders';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown = {};
  // body is optional — close can be called with no payload
  if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
  }
  const parsed = closeSalesOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const so = await closeSalesOrder(db, id, parsed.data);
    return NextResponse.json(so);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
