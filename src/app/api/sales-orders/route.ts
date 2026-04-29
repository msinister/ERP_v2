import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { SalesOrderStatus } from '@/generated/tenant';
import { createSalesOrderInputSchema } from '@/lib/validation/sales';
import {
  createSalesOrder,
  listSalesOrders,
} from '@/server/services/salesOrders';

// TODO: wire requirePermission() once lib/permissions exists

export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && statusParam in SalesOrderStatus
      ? (statusParam as SalesOrderStatus)
      : undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

  const list = await listSalesOrders(db, { customerId, status, skip, take });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createSalesOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const so = await createSalesOrder(db, parsed.data);
    return NextResponse.json(so, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
