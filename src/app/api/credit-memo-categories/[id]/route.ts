import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateCreditMemoCategoryInputSchema } from '@/lib/validation/creditMemoCategories';
import {
  getCategoryById,
  softDeleteCategory,
  updateCategory,
} from '@/server/services/creditMemoCategories';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const cat = await getCategoryById(db, id);
    if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(cat);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    // Reject any caller attempting to set `code` — it's immutable.
    // Validation schema has no `code` field, so it would be silently
    // stripped; surfacing a 400 makes the immutability explicit.
    if (
      body &&
      typeof body === 'object' &&
      'code' in (body as Record<string, unknown>)
    ) {
      return NextResponse.json(
        { error: 'code is immutable; create a new category instead' },
        { status: 400 },
      );
    }
    const parsed = updateCreditMemoCategoryInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const cat = await updateCategory(db, id, parsed.data, auditCtx);
    return NextResponse.json(cat);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const cat = await softDeleteCategory(db, id, auditCtx);
    return NextResponse.json(cat);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
