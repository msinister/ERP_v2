import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { batchAdjustmentInputSchema } from '@/lib/validation/inventoryAdjustments';
import { postBatchAdjustment } from '@/server/services/inventoryAdjustments';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Batch adjustment: one header + many lines, posts immediately. Each line
// applies FIFO-correctly (loss consumes, gain creates a layer) in one
// transaction — any failure rolls the whole batch back.
export async function POST(req: Request) {
  try {
    const user = await requirePermission(req, 'inventory_adjustments.create');
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = batchAdjustmentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const adjustment = await postBatchAdjustment(db, parsed.data, auditCtx);
    return NextResponse.json(adjustment, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
