import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateWorkOrderInputSchema } from '@/lib/validation/workOrders';
import {
  getWorkOrder,
  updateWorkOrder,
} from '@/server/services/workOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const wo = await getWorkOrder(db, id);
    if (!wo) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(wo);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// PATCH /api/work-orders/[id] — operator edits on DRAFT. Body:
//   { laborCost?: string|null, notes?: string|null }
export async function PATCH(req: Request, ctx: Ctx) {
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
    const parsed = updateWorkOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const wo = await updateWorkOrder(db, id, parsed.data, auditCtx);
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
