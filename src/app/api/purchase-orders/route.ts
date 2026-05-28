import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { PurchaseOrderStatus } from '@/generated/tenant';
import { createPurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import {
  createPurchaseOrder,
  listPurchaseOrdersPaged,
} from '@/server/services/purchaseOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

function parseDate(v: string | null, endOfDay: boolean): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'vendors.view');
    const url = new URL(req.url);
    const vendorId = url.searchParams.get('vendorId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in PurchaseOrderStatus
        ? (statusParam as PurchaseOrderStatus)
        : undefined;
    const q = url.searchParams.get('q') ?? undefined;
    const dateFrom = parseDate(url.searchParams.get('dateFrom'), false);
    const dateTo = parseDate(url.searchParams.get('dateTo'), true);
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

    // Paged shape: { rows, total }. No pre-6E consumer relied on the
    // raw-array shape (only this route + the per-vendor service call
    // used it), so widening to the paged variant is safe.
    const page = await listPurchaseOrdersPaged(db, {
      vendorId,
      status,
      q,
      dateFrom,
      dateTo,
      skip,
      take,
    });
    return NextResponse.json(page);
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
    const user = await requirePermission(req, 'vendors.create');
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createPurchaseOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const po = await createPurchaseOrder(db, parsed.data, auditCtx);
    return NextResponse.json(po, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
