import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { CreditMemoStatus } from '@/generated/tenant';
import { createCreditMemoInputSchema } from '@/lib/validation/invoicing';
import {
  createCreditMemoDraft,
  listCreditMemos,
} from '@/server/services/creditMemos';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { assertCustomerInScope } from '@/lib/permissions/scope';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'credit_memos.view_all');
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in CreditMemoStatus
        ? (statusParam as CreditMemoStatus)
        : undefined;
    const categoryId = url.searchParams.get('categoryId') ?? undefined;
    const fromParam = url.searchParams.get('from') ?? undefined;
    const toParam = url.searchParams.get('to') ?? undefined;
    const q = url.searchParams.get('q') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);
    const list = await listCreditMemos(db, {
      customerId,
      status,
      categoryId,
      createdAtFrom: fromParam ? new Date(fromParam) : undefined,
      createdAtTo: toParam ? new Date(toParam) : undefined,
      q,
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
    const actor = await requirePermission(req, 'credit_memos.create');
    const auditCtx = auditCtxFromRequest(req, actor);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createCreditMemoInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    await assertCustomerInScope(db, actor, parsed.data.customerId);
    const cm = await createCreditMemoDraft(db, parsed.data, auditCtx);
    return NextResponse.json(cm, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
