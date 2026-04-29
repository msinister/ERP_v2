import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { postReceipt } from '@/server/services/receipts';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await postReceipt(db, id);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
