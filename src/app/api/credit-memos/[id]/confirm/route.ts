import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { confirmCreditMemo } from '@/server/services/creditMemos';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const cm = await confirmCreditMemo(db, id);
    return NextResponse.json(cm);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
