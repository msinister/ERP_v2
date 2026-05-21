import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setSalesOrderSalesRepInputSchema } from '@/lib/validation/sales';
import { setSalesOrderSalesRep } from '@/server/services/salesOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Change (or clear) the per-order sales-rep override. Used by the SO
// detail page's inline edit. Requires the sales_orders.change_rep
// permission (Super Admin bypasses) → 403 otherwise. Allowed on any
// status; the change is not retroactive to accrued commission. Body:
// { salesRepId: string | null } (null = inherit the customer's rep).
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requirePermission(req, 'sales_orders.change_rep');
    const auditCtx = auditCtxFromRequest(req, actor);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = setSalesOrderSalesRepInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const so = await setSalesOrderSalesRep(db, id, parsed.data, auditCtx);
    return NextResponse.json(so);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
