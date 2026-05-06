import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getInventory } from '@/server/services/inventory';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const variantId = url.searchParams.get('variantId');
    const warehouseId = url.searchParams.get('warehouseId');

    if (!variantId || !warehouseId) {
      return NextResponse.json(
        { error: 'variantId and warehouseId are required' },
        { status: 400 },
      );
    }

    const item = await getInventory(db, variantId, warehouseId);
    if (!item) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
