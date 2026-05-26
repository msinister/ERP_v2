import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelPurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import { cancelPurchaseOrder } from '@/server/services/purchaseOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { PurchaseOrderCancelBlockedError } from '@/lib/errors/purchasing';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = cancelPurchaseOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const po = await cancelPurchaseOrder(db, id, parsed.data, auditCtx);
    return NextResponse.json(po);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof PurchaseOrderCancelBlockedError) {
      return NextResponse.json(
        { error: e.message, code: e.code, receipts: e.receipts },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
