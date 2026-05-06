import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCreditMemo } from '@/server/services/creditMemos';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const cm = await getCreditMemo(db, id);
    if (!cm) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(cm);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
