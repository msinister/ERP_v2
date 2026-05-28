import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updatePurchaseOrderLineFieldsInputSchema } from '@/lib/validation/purchasing';
import { updatePurchaseOrderLineFields } from '@/server/services/purchaseOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// PATCH — inline per-field edit on a single PO line. Allowed on
// CONFIRMED + PARTIALLY_RECEIVED. Body is a partial of:
//   { qtyOrdered, unitCost, vendorSku, manufacturerPartNumber, notes }
// where vendorSku / MPN / notes accept null to clear. Validation
// enforces non-empty + per-field shape. Service enforces the status
// gate + the qtyOrdered >= qtyReceived floor.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; lineId: string }> },
) {
  try {
    const user = await requirePermission(req, 'vendors.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, lineId } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updatePurchaseOrderLineFieldsInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const line = await updatePurchaseOrderLineFields(
      db,
      id,
      lineId,
      parsed.data,
      auditCtx,
    );
    return NextResponse.json({
      id: line.id,
      qtyOrdered: line.qtyOrdered.toString(),
      qtyReceived: line.qtyReceived.toString(),
      unitCost: line.unitCost.toString(),
      vendorSku: line.vendorSku,
      manufacturerPartNumber: line.manufacturerPartNumber,
      notes: line.notes,
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
