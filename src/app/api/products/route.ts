import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { productCreateSchema } from '@/lib/validation/product';
import { createProduct, listProducts } from '@/server/services/products';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

const MAX_TAKE = 200;

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0);
    const takeRaw = Number(url.searchParams.get('take') ?? 50) || 50;
    const take = Math.min(MAX_TAKE, Math.max(1, takeRaw));
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    const products = await listProducts(db, { skip, take, includeArchived });
    return NextResponse.json({ products });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    const parsed = productCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const product = await createProduct(db, parsed.data, auditCtx);
    return NextResponse.json(product, { status: 201 });
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
