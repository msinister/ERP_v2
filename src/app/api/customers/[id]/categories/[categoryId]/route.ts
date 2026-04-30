import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { unassignCategory } from '@/server/services/customerCategories';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; categoryId: string }> },
) {
  const { id, categoryId } = await ctx.params;
  try {
    const result = await unassignCategory(db, id, categoryId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
