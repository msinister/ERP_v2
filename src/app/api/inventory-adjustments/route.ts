import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { quickAdjustmentInputSchema } from '@/lib/validation/inventoryAdjustments';
import { postQuickAdjustment } from '@/server/services/inventoryAdjustments';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Quick adjustment: single line, posts immediately (FIFO consume for a
// loss, new layer for a gain) + auto-posts the adjustment JE.
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
    const parsed = quickAdjustmentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const adjustment = await postQuickAdjustment(db, parsed.data, auditCtx);
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
