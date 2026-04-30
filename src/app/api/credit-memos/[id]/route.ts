import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCreditMemo } from '@/server/services/creditMemos';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cm = await getCreditMemo(db, id);
  if (!cm) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(cm);
}
