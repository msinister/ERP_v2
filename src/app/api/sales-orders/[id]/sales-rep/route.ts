import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setSalesOrderSalesRepInputSchema } from '@/lib/validation/sales';
import { setSalesOrderSalesRep } from '@/server/services/salesOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Change (or clear) the per-order sales-rep override. Used by the SO
// detail page's inline edit. Allowed on Draft/Confirmed/Dispatched; the
// service rejects Closed/Cancelled. Body: { salesRepId: string | null }
// (null = inherit the customer's rep).
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
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
