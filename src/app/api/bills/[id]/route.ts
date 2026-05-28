import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateBillInputSchema } from '@/lib/validation/ap';
import { getBill, softDeleteBill, updateBill } from '@/server/services/bills';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'bills.view');
    const { id } = await ctx.params;
    const bill = await getBill(db, id);
    if (!bill) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(bill);
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
    const user = await requirePermission(req, 'bills.create');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateBillInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const bill = await updateBill(db, id, parsed.data, auditCtx);
    return NextResponse.json(bill);
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
    const user = await requirePermission(req, 'bills.void');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const bill = await softDeleteBill(db, id, auditCtx);
    return NextResponse.json(bill);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
