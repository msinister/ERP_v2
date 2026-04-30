import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCategoryByCode } from '@/server/services/creditMemoCategories';

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const cat = await getCategoryByCode(db, decodeURIComponent(code));
  if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(cat);
}
