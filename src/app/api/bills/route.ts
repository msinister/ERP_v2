import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { BillPaymentStatus, BillSource, BillStatus } from '@/generated/tenant';
import { createBillInputSchema } from '@/lib/validation/ap';
import { createBill, listBillsPaged } from '@/server/services/bills';
import { requireAuth } from '@/lib/auth/requireAuth';
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
    await requireAuth(req);
    const url = new URL(req.url);
    const vendorId = url.searchParams.get('vendorId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in BillStatus
        ? (statusParam as BillStatus)
        : undefined;
    const paymentStatusParam = url.searchParams.get('paymentStatus');
    const paymentStatus =
      paymentStatusParam && paymentStatusParam in BillPaymentStatus
        ? (paymentStatusParam as BillPaymentStatus)
        : undefined;
    const sourceParam = url.searchParams.get('source');
    const source =
      sourceParam && sourceParam in BillSource
        ? (sourceParam as BillSource)
        : undefined;
    const q = url.searchParams.get('q') ?? undefined;
    // Accept both `dateFrom`/`dateTo` (canonical, used by the GUI) and
    // the older `from`/`to` (used by some scripts) — first one wins.
    const dateFrom =
      parseDate(url.searchParams.get('dateFrom'), false) ??
      parseDate(url.searchParams.get('from'), false);
    const dateTo =
      parseDate(url.searchParams.get('dateTo'), true) ??
      parseDate(url.searchParams.get('to'), true);
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(
      Number(url.searchParams.get('take') ?? '100') || 100,
      500,
    );
    // Paged shape `{ rows, total }`. The previous raw-array shape had
    // no GUI consumer (only this route + scripts that pass `from`/`to`
    // which still work), so widening to paged is safe.
    const page = await listBillsPaged(db, {
      vendorId,
      status,
      paymentStatus,
      source,
      billDateFrom: dateFrom,
      billDateTo: dateTo,
      q,
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
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createBillInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const bill = await createBill(db, parsed.data, auditCtx);
    return NextResponse.json(bill, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
