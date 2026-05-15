import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateSalesOrderLineQtyShippedInputSchema } from '@/lib/validation/sales';
import { updateSalesOrderLineQtyShipped } from '@/server/services/salesOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Inline qtyShipped editor for the SO detail page's Qty shipped column.
// Service enforces status gating (CONFIRMED / DISPATCHED only),
// belongs-to-SO, and qtyShipped ≤ qtyOrdered.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; lineId: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, lineId } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateSalesOrderLineQtyShippedInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const line = await updateSalesOrderLineQtyShipped(
      db,
      id,
      lineId,
      parsed.data,
      auditCtx,
    );
    return NextResponse.json({
      id: line.id,
      qtyShipped: line.qtyShipped.toString(),
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
