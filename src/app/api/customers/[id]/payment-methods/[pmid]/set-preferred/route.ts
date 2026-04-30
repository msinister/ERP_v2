import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setPreferred } from '@/server/services/customerPaymentMethods';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  const { pmid } = await ctx.params;
  try {
    const pm = await setPreferred(db, pmid);
    return NextResponse.json(pm);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
