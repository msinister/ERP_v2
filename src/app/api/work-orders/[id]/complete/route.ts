import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { completeWorkOrderInputSchema } from '@/lib/validation/workOrders';
import { completeWorkOrder } from '@/server/services/workOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// POST — IN_PROGRESS → IN_PROGRESS (partial) or COMPLETED. Body:
//   { qtyToComplete: string }
// Heavy lift: FIFO consume per component, produce finished-good layer,
// post JE. Errors from the service (insufficient stock, exceeds
// remaining, status mismatch) flow through as 400 messages.
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
    const parsed = completeWorkOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await completeWorkOrder(db, id, parsed.data, auditCtx);
    // Response wraps both the persisted work order and any negative-
    // allocation warnings. UI surfaces warnings as a toast after the
    // success message. Empty `warnings` is the clean-build case.
    return NextResponse.json({
      ...result.workOrder,
      warnings: result.warnings,
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
