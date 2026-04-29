import { NextResponse } from 'next/server';                                                                                                                                                                                                       import { Prisma } from '@/generated/tenant';
  import { db } from '@/lib/db';
  import { productCreateSchema } from '@/lib/validation/product';
  import { createProduct, listProducts } from '@/server/services/products';

  // TODO: wire requirePermission() once lib/permissions exists
  // TODO: wire audit() once lib/audit exists

  const MAX_TAKE = 200;

  export async function GET(req: Request) {
    const url = new URL(req.url);
    const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0);
    const takeRaw = Number(url.searchParams.get('take') ?? 50) || 50;
    const take = Math.min(MAX_TAKE, Math.max(1, takeRaw));
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    try {
      const products = await listProducts(db, { skip, take, includeArchived });
      return NextResponse.json({ products });
    } catch {
      return NextResponse.json({ error: 'internal' }, { status: 500 });
    }
  }

  export async function POST(req: Request) {
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

    try {
      const product = await createProduct(db, parsed.data);
      return NextResponse.json(product, { status: 201 });
    } catch (err) {
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
