import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reopenSalesOrderInputSchema } from '@/lib/validation/sales';
import { reopenSalesOrder } from '@/server/services/salesOrders';
import { SalesOrderReopenBlockedError } from '@/lib/errors/credit';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// CLOSED → CONFIRMED | DISPATCHED | CANCELLED. Body:
//   { targetStatus, paymentDecision?: 'none'|'unapply', unapplyReason? }
//
// When the linked invoice has non-reversed applied payments and the
// caller doesn't explicitly opt to unapply, the service throws
// SalesOrderReopenBlockedError. The route translates it into a 409
// with the structured payload so the UI can render its confirmation
// dialog.
export async function POST(
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
    const parsed = reopenSalesOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const so = await reopenSalesOrder(db, id, parsed.data, auditCtx);
    return NextResponse.json(so);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof SalesOrderReopenBlockedError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          invoiceId: e.invoiceId,
          invoiceNumber: e.invoiceNumber,
          payments: e.payments,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
