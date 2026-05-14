import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { VendorAddressKind } from '@/generated/tenant';
import { vendorAddressInputSchema } from '@/lib/validation/vendors';
import {
  addVendorAddress,
  listVendorAddresses,
} from '@/server/services/vendorAddresses';
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
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind =
      kindParam && kindParam in VendorAddressKind
        ? (kindParam as VendorAddressKind)
        : undefined;
    const addresses = await listVendorAddresses(db, id, { kind });
    return NextResponse.json(addresses);
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
    const parsed = vendorAddressInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const address = await addVendorAddress(db, id, parsed.data, auditCtx);
    return NextResponse.json(address, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
