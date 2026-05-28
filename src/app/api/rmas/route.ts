import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { RmaStatus } from '@/generated/tenant';
import { createRmaInputSchema } from '@/lib/validation/invoicing';
import { createRma, listRmas } from '@/server/services/rmas';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { assertCustomerInScope } from '@/lib/permissions/scope';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'rmas.view_all');
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId') ?? undefined;
    const invoiceId = url.searchParams.get('invoiceId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in RmaStatus
        ? (statusParam as RmaStatus)
        : undefined;
    const fromParam = url.searchParams.get('from') ?? undefined;
    const toParam = url.searchParams.get('to') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);
    const list = await listRmas(db, {
      customerId,
      invoiceId,
      status,
      createdAtFrom: fromParam ? new Date(fromParam) : undefined,
      createdAtTo: toParam ? new Date(toParam) : undefined,
      skip,
      take,
    });
    return NextResponse.json(list);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requirePermission(req, 'rmas.approve');
    const auditCtx = auditCtxFromRequest(req, actor);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createRmaInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    await assertCustomerInScope(db, actor, parsed.data.customerId);
    const rma = await createRma(db, parsed.data, auditCtx);
    return NextResponse.json(rma, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
