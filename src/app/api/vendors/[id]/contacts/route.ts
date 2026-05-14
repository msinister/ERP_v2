import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createVendorContactInputSchema } from '@/lib/validation/vendors';
import {
  createVendorContact,
  listVendorContacts,
} from '@/server/services/vendorContacts';
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
    const contacts = await listVendorContacts(db, id);
    return NextResponse.json(contacts);
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
    const parsed = createVendorContactInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const contact = await createVendorContact(db, id, parsed.data, auditCtx);
    return NextResponse.json(contact, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
