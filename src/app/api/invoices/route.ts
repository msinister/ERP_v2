import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { InvoiceStatus } from '@/generated/tenant';
import { listInvoices } from '@/server/services/invoices';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in InvoiceStatus
        ? (statusParam as InvoiceStatus)
        : undefined;
    const fromParam = url.searchParams.get('from') ?? undefined;
    const toParam = url.searchParams.get('to') ?? undefined;
    const q = url.searchParams.get('q') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);
    const list = await listInvoices(db, {
      customerId,
      status,
      invoiceDateFrom: fromParam ? new Date(fromParam) : undefined,
      invoiceDateTo: toParam ? new Date(toParam) : undefined,
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
