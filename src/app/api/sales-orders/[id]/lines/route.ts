import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addSalesOrderLinesInputSchema } from '@/lib/validation/sales';
import { addSalesOrderLines } from '@/server/services/salesOrders';
import {
  ArHoldExceededError,
  CreditLimitExceededError,
} from '@/lib/errors/credit';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Add lines to a CONFIRMED order. Existing lines remain untouched;
// new lines reserve inventory immediately and the credit-limit / AR-
// hold gates re-run against the post-add total. Body:
//   { lines: SalesOrderLineInput[] }
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
    const parsed = addSalesOrderLinesInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const so = await addSalesOrderLines(db, id, parsed.data, auditCtx);
    return NextResponse.json(so);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof CreditLimitExceededError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          creditLimit: e.creditLimit,
          arBalance: e.arBalance,
          openSosTotal: e.openSosTotal,
          thisOrderTotal: e.thisOrderTotal,
          projectedExposure: e.projectedExposure,
        },
        { status: 409 },
      );
    }
    if (e instanceof ArHoldExceededError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          arHoldDays: e.arHoldDays,
          worstInvoiceNumber: e.worstInvoiceNumber,
          worstInvoiceDaysPastDue: e.worstInvoiceDaysPastDue,
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
