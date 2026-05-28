import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma, ReceiptStatus } from '@/generated/tenant';
import { updateReceiptInputSchema } from '@/lib/validation/receipts';
import { getReceipt, updateDraftReceipt } from '@/server/services/receipts';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'vendors.view');
    const { id } = await ctx.params;
    const r = await getReceipt(db, id);
    if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(r);
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
    const user = await requirePermission(req, 'vendors.receive');
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateReceiptInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const r = await updateDraftReceipt(db, id, parsed.data, auditCtx);
    return NextResponse.json(r);
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
    await requirePermission(req, 'vendors.receive');
    const { id } = await ctx.params;
    // Soft-delete only DRAFT or CANCELLED receipts.
    const result = await db.$transaction(async (tx) => {
      const before = await tx.receipt.findUnique({ where: { id } });
      if (!before) throw new Error('not found');
      if (before.deletedAt) throw new Error('already soft-deleted');
      if (
        before.status !== ReceiptStatus.DRAFT &&
        before.status !== ReceiptStatus.CANCELLED
      ) {
        throw new Error(`Soft-delete only allowed for DRAFT or CANCELLED Receipts (got ${before.status})`);
      }
      return tx.receipt.update({ where: { id }, data: { deletedAt: new Date() } });
    });
    return NextResponse.json(result);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
