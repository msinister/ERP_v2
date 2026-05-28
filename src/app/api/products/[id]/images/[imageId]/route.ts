import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  deleteProductImage,
  setPrimaryProductImage,
} from '@/server/services/productImages';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string; imageId: string }> };

// PATCH body: { setPrimary: true }. Only `setPrimary` is supported today;
// reorder / altText edit can extend this schema later.
const patchSchema = z.object({
  setPrimary: z.literal(true),
});

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const user = await requirePermission(req, 'products.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, imageId } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const image = await setPrimaryProductImage(db, id, imageId, auditCtx);
    return NextResponse.json(image);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requirePermission(req, 'products.edit');
    const auditCtx = auditCtxFromRequest(req, user);
    const { imageId } = await ctx.params;
    const image = await deleteProductImage(db, imageId, auditCtx);
    return NextResponse.json(image);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
