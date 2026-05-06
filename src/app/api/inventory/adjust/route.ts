import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { adjustmentInputSchema } from '@/lib/validation/inventory';
import { createAdjustment } from '@/server/services/movements';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    const parsed = adjustmentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const variant = await db.productVariant.findFirst({
      where: { id: parsed.data.variantId, deletedAt: null },
    });
    if (!variant) {
      return NextResponse.json({ error: 'variant not found' }, { status: 404 });
    }

    const warehouse = await db.warehouse.findFirst({
      where: { id: parsed.data.warehouseId, deletedAt: null },
    });
    if (!warehouse) {
      return NextResponse.json({ error: 'warehouse not found' }, { status: 404 });
    }

    const movement = await createAdjustment(db, parsed.data, auditCtx);
    return NextResponse.json(movement, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
