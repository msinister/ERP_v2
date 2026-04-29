import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getVariant } from '@/server/services/variants';
import { listInventoryByVariant } from '@/server/services/inventory';

type Ctx = { params: Promise<{ variantId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { variantId } = await ctx.params;

  const variant = await getVariant(db, variantId);
  if (!variant) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const inventory = await listInventoryByVariant(db, variantId);
    return NextResponse.json({ inventory });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
