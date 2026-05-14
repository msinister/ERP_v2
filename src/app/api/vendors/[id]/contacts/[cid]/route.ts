import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateVendorContactInputSchema } from '@/lib/validation/vendors';
import {
  softDeleteVendorContact,
  updateVendorContact,
} from '@/server/services/vendorContacts';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { cid } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateVendorContactInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const contact = await updateVendorContact(db, cid, parsed.data, auditCtx);
    return NextResponse.json(contact);
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
  ctx: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { cid } = await ctx.params;
    const contact = await softDeleteVendorContact(db, cid, auditCtx);
    return NextResponse.json(contact);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
