import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { softDeleteRole, updateRole } from '@/server/services/roles';
import { updateRoleInputSchema } from '@/lib/validation/roles';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, actor);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateRoleInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const role = await updateRole(db, id, parsed.data, auditCtx);
    return NextResponse.json(role);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    const msg = e instanceof Error ? e.message : 'internal';
    if (/unique|exists|duplicate/i.test(msg)) {
      return NextResponse.json(
        { error: 'A role with this name already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, actor);
    const { id } = await ctx.params;
    const role = await softDeleteRole(db, id, auditCtx);
    return NextResponse.json(role);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
