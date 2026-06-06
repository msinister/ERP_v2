import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getDocumentMetadata,
  updateDocument,
  softDeleteDocument,
} from '@/server/services/customerDocuments';
import { updateDocumentInputSchema } from '@/lib/validation/customers';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  try {
    await requireAuth(req);
    const { did } = await ctx.params;
    const doc = await getDocumentMetadata(db, did);
    if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(doc);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { did } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateDocumentInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const doc = await updateDocument(db, did, parsed.data, auditCtx);
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest);
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
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { did } = await ctx.params;
    const doc = await softDeleteDocument(db, did, auditCtx);
    // Same defense-in-depth strip on response.
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
