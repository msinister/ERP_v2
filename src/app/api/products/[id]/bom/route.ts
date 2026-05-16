import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setProductBomInputSchema } from '@/lib/validation/product';
import { getProductBom, setProductBom } from '@/server/services/bom';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

// GET — read the current BOM (lines + labor cost). 404 when the
// product doesn't exist or is soft-deleted; empty `lines` is the
// happy answer for products that have no BOM defined yet.
export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const bom = await getProductBom(db, id);
    if (!bom) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(bom);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// PUT — wholesale-replace the BOM. Body:
//   { lines: BomLineInput[], laborCost?: string | null }
// Service rejects DROP_SHIP / SERVICE types and self-referential
// component variants. Returns the freshly-read BOM.
export async function PUT(req: Request, ctx: Ctx) {
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
    const parsed = setProductBomInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const bom = await setProductBom(db, id, parsed.data, auditCtx);
    return NextResponse.json(bom);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
