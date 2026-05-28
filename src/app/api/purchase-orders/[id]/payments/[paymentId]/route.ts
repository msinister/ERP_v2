import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { voidPoPaymentInputSchema } from '@/lib/validation/purchasing';
import { voidPoPayment } from '@/server/services/poPayments';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// DELETE — void/reverse a deposit. Posts the reversing JE(s): unwinds any
// live applications (DR 1510 / CR AP) then reverses the cash leg
// (DR cash / CR 1510). Keeps the row (status REVERSED). A reason is
// required and read from the request body.
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; paymentId: string }> },
) {
  try {
    const user = await requirePermission(req, 'vendors.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, paymentId } = await ctx.params;
    // DELETE carries a JSON body with the reason. Tolerate an empty body —
    // validation then surfaces the missing-reason error.
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = voidPoPaymentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const payment = await voidPoPayment(db, id, paymentId, parsed.data, auditCtx);
    return NextResponse.json(payment);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
