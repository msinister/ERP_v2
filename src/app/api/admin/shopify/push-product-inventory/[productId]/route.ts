import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { pushInventoryForProduct } from '@/server/services/shopifyInventoryPush';

// Push current ERP inventory for a single product to all Shopify stores that
// list it. Useful for operator overrides — e.g. after an adjustment that
// happened before inventoryPushEnabled was turned on.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ productId: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { productId } = await ctx.params;

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, sku: true },
    });
    if (!product) {
      return NextResponse.json({ error: 'product not found' }, { status: 404 });
    }

    const results = await pushInventoryForProduct(db, productId);
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
