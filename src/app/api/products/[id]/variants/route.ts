import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { variantCreateSchema } from '@/lib/validation/product';
import { getProduct } from '@/server/services/products';
import {
  createVariant,
  listVariantsForProduct,
} from '@/server/services/variants';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requirePermission(req, 'products.view');
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    const product = await getProduct(db, id);
    if (!product) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const variants = await listVariantsForProduct(db, id, { includeArchived });
    return NextResponse.json({ variants });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requirePermission(req, 'products.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    const merged =
      body && typeof body === 'object'
        ? { ...(body as Record<string, unknown>), productId: id }
        : { productId: id };

    const parsed = variantCreateSchema.safeParse(merged);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const product = await getProduct(db, id);
    if (!product) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const variant = await createVariant(db, parsed.data, auditCtx);
    return NextResponse.json(variant, { status: 201 });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'SKU already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
