import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { unassignTag } from '@/server/services/customerTags';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; tagLabel: string }> },
) {
  const { id, tagLabel } = await ctx.params;
  try {
    const result = await unassignTag(db, id, decodeURIComponent(tagLabel));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
