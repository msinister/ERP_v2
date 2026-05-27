import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { getStore } from '@/server/services/shopifyStores';
import { pushAllInventory } from '@/server/services/shopifyInventoryPush';

// Walk every product matched by this store's routing rules and push current
// available inventory. Runs INLINE per pilot scale; the result summary
// (pushed/skipped/errors) is persisted to ShopifyStore.lastPushResult so
// the admin UI can render it on the next page load. Browser tab must stay
// open for the response. Upgrade path: Inngest, same as full-sync.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;

    const store = await getStore(db, id);
    if (!store) {
      return NextResponse.json({ error: 'store not found' }, { status: 404 });
    }
    if (!store.inventoryPushEnabled) {
      return NextResponse.json(
        {
          error:
            'Inventory push is disabled for this store — enable it first',
        },
        { status: 400 },
      );
    }
    if (!store.shopifyLocationId) {
      return NextResponse.json(
        {
          error:
            'This store has no shopifyLocationId configured — set the location id first',
        },
        { status: 400 },
      );
    }

    const runs = await pushAllInventory(db, id);
    return NextResponse.json({ ok: true, run: runs[id] ?? null });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
