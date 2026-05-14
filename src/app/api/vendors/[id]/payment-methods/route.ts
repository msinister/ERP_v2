import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createVendorPaymentMethodInputSchema } from '@/lib/validation/vendors';
import {
  createVendorPaymentMethod,
  listVendorPaymentMethods,
} from '@/server/services/vendorPaymentMethods';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    // listVendorPaymentMethods returns metadata only (encrypted columns
    // stripped at the service boundary). Cleartext requires the audited
    // /cleartext route below.
    const list = await listVendorPaymentMethods(db, id);
    return NextResponse.json(list);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

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
    const parsed = createVendorPaymentMethodInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const pm = await createVendorPaymentMethod(db, id, parsed.data, auditCtx);
    return NextResponse.json(pm, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
