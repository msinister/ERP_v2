import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAccountByCode } from '@/server/services/glAccounts';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    await requireAuth(req);
    const { code } = await ctx.params;
    const account = await getAccountByCode(db, decodeURIComponent(code));
    if (!account) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(account);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
