import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCategoryByCode } from '@/server/services/creditMemoCategories';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    await requireAuth(req);
    const { code } = await ctx.params;
    const cat = await getCategoryByCode(db, decodeURIComponent(code));
    if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(cat);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
