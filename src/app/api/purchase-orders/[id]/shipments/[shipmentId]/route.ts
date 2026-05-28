import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updatePoShipmentInputSchema } from '@/lib/validation/purchasing';
import {
  softDeletePoShipment,
  updatePoShipment,
} from '@/server/services/poShipments';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// PATCH — partial inline edit of a shipment (status, tracking, carton/weight,
// ETA, notes). Matches the codebase's per-field edit convention.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; shipmentId: string }> },
) {
  try {
    const user = await requirePermission(req, 'vendors.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, shipmentId } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updatePoShipmentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const shipment = await updatePoShipment(db, id, shipmentId, parsed.data, auditCtx);
    return NextResponse.json(shipment);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

// DELETE — soft-delete (remove) a shipment.
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; shipmentId: string }> },
) {
  try {
    const user = await requirePermission(req, 'vendors.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, shipmentId } = await ctx.params;
    const shipment = await softDeletePoShipment(db, id, shipmentId, auditCtx);
    return NextResponse.json(shipment);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
