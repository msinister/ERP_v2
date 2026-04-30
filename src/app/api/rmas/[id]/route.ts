import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRma } from '@/server/services/rmas';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rma = await getRma(db, id);
  if (!rma) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(rma);
}
