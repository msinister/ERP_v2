import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { InvoiceStatus } from '@/generated/tenant';
import { listInvoices } from '@/server/services/invoices';

export async function GET(req: Request) {
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
}
