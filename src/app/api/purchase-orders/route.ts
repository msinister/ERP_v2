import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { PurchaseOrderStatus } from '@/generated/tenant';
import { createPurchaseOrderInputSchema } from '@/lib/validation/purchasing';
import {
  createPurchaseOrder,
  listPurchaseOrders,
} from '@/server/services/purchaseOrders';

// TODO: wire requirePermission() once lib/permissions exists

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendorId = url.searchParams.get('vendorId') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && statusParam in PurchaseOrderStatus
      ? (statusParam as PurchaseOrderStatus)
      : undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

  const list = await listPurchaseOrders(db, { vendorId, status, skip, take });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
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
  try {
    const po = await createPurchaseOrder(db, parsed.data);
    return NextResponse.json(po, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
