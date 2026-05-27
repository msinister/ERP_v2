import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { shopifyStoreCreateSchema } from '@/lib/validation/shopifyStores';
import { createStore, listStores } from '@/server/services/shopifyStores';

// GET → list every store (public-safe, no secrets). POST → create a new
// store. Both super-admin gated.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const includeArchived =
      new URL(req.url).searchParams.get('includeArchived') === '1';
    const stores = await listStores(db, { includeArchived });
    return NextResponse.json({ stores });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    const ctx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = shopifyStoreCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const store = await createStore(db, parsed.data, ctx);
    return NextResponse.json(store, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
