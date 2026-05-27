import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { shopifyStoreUpdateSchema } from '@/lib/validation/shopifyStores';
import {
  archiveStore,
  getStore,
  updateStore,
} from '@/server/services/shopifyStores';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const store = await getStore(db, id);
    if (!store) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(store);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function PUT(
  req: Request,
  routeCtx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await routeCtx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = shopifyStoreUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const store = await updateStore(db, id, parsed.data, auditCtx);
    return NextResponse.json(store);
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
  routeCtx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await routeCtx.params;
    await archiveStore(db, id, auditCtx);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
