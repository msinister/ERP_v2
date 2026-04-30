import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAccountByCode } from '@/server/services/glAccounts';

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const account = await getAccountByCode(db, decodeURIComponent(code));
  if (!account) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(account);
}
