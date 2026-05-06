import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getVariant } from '@/server/services/variants';
import { listInventoryByVariant } from '@/server/services/inventory';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ variantId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireAuth(req);
    const { variantId } = await ctx.params;

    const variant = await getVariant(db, variantId);
    if (!variant) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const inventory = await listInventoryByVariant(db, variantId);
    return NextResponse.json({ inventory });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
