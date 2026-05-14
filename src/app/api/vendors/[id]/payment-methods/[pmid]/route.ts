import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateVendorPaymentMethodInputSchema } from '@/lib/validation/vendors';
import {
  softDeleteVendorPaymentMethod,
  updateVendorPaymentMethod,
} from '@/server/services/vendorPaymentMethods';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { pmid } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    // Update only covers label / isPreferred / active per the service
    // contract. Payload is immutable; to rotate account numbers, soft-
    // delete the row and create a new one.
    const parsed = updateVendorPaymentMethodInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const pm = await updateVendorPaymentMethod(db, pmid, parsed.data, auditCtx);
    return NextResponse.json(pm);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { pmid } = await ctx.params;
    const pm = await softDeleteVendorPaymentMethod(db, pmid, auditCtx);
    return NextResponse.json(pm);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
