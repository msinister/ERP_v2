import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getInvoice } from '@/server/services/invoices';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const inv = await getInvoice(db, id);
    if (!inv) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(inv);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
