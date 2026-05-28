import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { closePurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import { closePurchaseOrder } from '@/server/services/purchaseOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Manual PO close — CONFIRMED or PARTIALLY_RECEIVED only. Body:
// { reason: string }. Reason is required (validator rejects empty
// strings) and persists on PurchaseOrder.closeReason so the detail
// page can surface it and applyComputedPoStatus can recognize the
// close as manual on subsequent receipt cancels.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requirePermission(req, 'vendors.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = closePurchaseOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const po = await closePurchaseOrder(db, id, parsed.data, auditCtx);
    return NextResponse.json(po);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
