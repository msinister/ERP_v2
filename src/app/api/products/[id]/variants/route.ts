import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { variantCreateSchema } from '@/lib/validation/product';
import { getProduct } from '@/server/services/products';
import {
  createVariant,
  listVariantsForProduct,
} from '@/server/services/variants';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get('includeArchived') === 'true';

  const product = await getProduct(db, id);
  if (!product) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const variants = await listVariantsForProduct(db, id, { includeArchived });
    return NextResponse.json({ variants });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
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

  try {
    const variant = await createVariant(db, parsed.data);
    return NextResponse.json(variant, { status: 201 });
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
