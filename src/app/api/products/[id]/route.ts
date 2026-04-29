import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { productUpdateSchema } from '@/lib/validation/product';
import {
  archiveProduct,
  getProduct,
  updateProduct,
} from '@/server/services/products';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const product = await getProduct(db, id);
    if (!product) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(product);
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = productUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const existing = await getProduct(db, id);
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const product = await updateProduct(db, id, parsed.data);
    return NextResponse.json(product);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        return NextResponse.json(
          { error: 'SKU already exists' },
          { status: 409 },
        );
      }
      if (err.code === 'P2025') {
        return NextResponse.json({ error: 'not found' }, { status: 404 });
      }
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  const existing = await getProduct(db, id);
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const product = await archiveProduct(db, id);
    return NextResponse.json(product);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
