import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  updateSalesOrderLineFieldsInputSchema,
  updateSalesOrderLineQtyShippedInputSchema,
} from '@/lib/validation/sales';
import {
  updateSalesOrderLineFields,
  updateSalesOrderLineQtyShipped,
} from '@/server/services/salesOrders';
import {
  ArHoldExceededError,
  CreditLimitExceededError,
} from '@/lib/errors/credit';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// PATCH dispatches based on payload shape:
//   - { qtyShipped } → updateSalesOrderLineQtyShipped (CONFIRMED + DISPATCHED).
//   - any of { qtyOrdered, unitPrice, discountPercent, discountAmount,
//     customerNote, internalNote } → updateSalesOrderLineFields (DRAFT
//     + CONFIRMED). Re-runs the credit-limit + AR-hold gate on CONFIRMED
//     when the total changes; surfaces 409 with structured detail so the
//     inline editor can revert + toast.
//
// Mixing qtyShipped with the other fields in one request is rejected —
// the two flows have different status windows.
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

    const isObject =
      body != null && typeof body === 'object' && !Array.isArray(body);
    if (!isObject) {
      return NextResponse.json(
        { error: 'expected an object body' },
        { status: 400 },
      );
    }
    const keys = Object.keys(body as Record<string, unknown>);
    const hasShipped = keys.includes('qtyShipped');
    const FIELD_KEYS = [
      'qtyOrdered',
      'unitPrice',
      'discountPercent',
      'discountAmount',
      'customerNote',
      'internalNote',
    ];
    const hasFieldEdit = keys.some((k) => FIELD_KEYS.includes(k));

    if (hasShipped && hasFieldEdit) {
      return NextResponse.json(
        {
          error:
            'qtyShipped cannot be combined with other field edits; send them as separate requests',
        },
        { status: 400 },
      );
    }

    if (hasShipped) {
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
    }

    // Field-edit path.
    const parsed = updateSalesOrderLineFieldsInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const line = await updateSalesOrderLineFields(
      db,
      id,
      lineId,
      parsed.data,
      auditCtx,
    );
    return NextResponse.json({
      id: line.id,
      qtyOrdered: line.qtyOrdered.toString(),
      unitPrice: line.unitPrice.toString(),
      priceRule: line.priceRule,
      discountPercent: line.discountPercent?.toString() ?? null,
      discountAmount: line.discountAmount?.toString() ?? null,
      customerNote: line.customerNote,
      internalNote: line.internalNote,
    });
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
