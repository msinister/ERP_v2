import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getInvoice } from '@/server/services/invoices';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = await getInvoice(db, id);
  if (!inv) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(inv);
}
