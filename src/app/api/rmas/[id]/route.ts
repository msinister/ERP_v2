import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRma } from '@/server/services/rmas';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const rma = await getRma(db, id);
    if (!rma) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(rma);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
