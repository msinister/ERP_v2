import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { productUpdateSchema } from '@/lib/validation/product';
import {
  archiveProduct,
  getProduct,
  updateProduct,
} from '@/server/services/products';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const product = await getProduct(db, id);
    if (!product) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(product);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

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

    const product = await updateProduct(db, id, parsed.data, auditCtx);
    return NextResponse.json(product);
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
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

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;

    const existing = await getProduct(db, id);
    if (!existing) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const product = await archiveProduct(db, id, auditCtx);
    return NextResponse.json(product);
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
