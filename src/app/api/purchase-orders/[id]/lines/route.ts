import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addPurchaseOrderLinesInputSchema } from '@/lib/validation/purchasing';
import { addPurchaseOrderLines } from '@/server/services/purchaseOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Add lines to a CONFIRMED or PARTIALLY_RECEIVED PO. Existing lines
// remain untouched; new lines start at qtyReceived = 0. No inventory
// side-effects (PO lines don't reserve like SO lines do). Body:
//   { lines: PurchaseOrderLineInput[] }
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
    const parsed = addPurchaseOrderLinesInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const po = await addPurchaseOrderLines(db, id, parsed.data, auditCtx);
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
