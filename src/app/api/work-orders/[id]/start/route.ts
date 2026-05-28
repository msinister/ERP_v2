import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startWorkOrder } from '@/server/services/workOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// POST — DRAFT → IN_PROGRESS. No body required.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requirePermission(req, 'work_orders.start');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const wo = await startWorkOrder(db, id, auditCtx);
    return NextResponse.json(wo);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
