import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { confirmSalesOrder } from '@/server/services/salesOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import {
  ArHoldExceededError,
  CreditLimitExceededError,
} from '@/lib/errors/credit';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const so = await confirmSalesOrder(db, id, auditCtx);
    return NextResponse.json(so);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    // Surface the typed credit/AR-hold errors with their rich numeric
    // context so the GUI can render an actionable breakdown without
    // re-querying. Each error class carries a stable `code` discriminator.
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
