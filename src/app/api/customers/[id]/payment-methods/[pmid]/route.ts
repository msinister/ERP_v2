import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { softDeletePaymentMethod } from '@/server/services/customerPaymentMethods';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  const { pmid } = await ctx.params;
  try {
    const pm = await softDeletePaymentMethod(db, pmid);
    return NextResponse.json(pm);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
