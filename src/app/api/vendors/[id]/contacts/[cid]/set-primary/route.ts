import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setPrimaryVendorContact } from '@/server/services/vendorContacts';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { cid } = await ctx.params;
    const contact = await setPrimaryVendorContact(db, cid, auditCtx);
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
