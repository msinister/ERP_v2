import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getPayment } from '@/server/services/payments';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = await getPayment(db, id);
  if (!p) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(p);
}
