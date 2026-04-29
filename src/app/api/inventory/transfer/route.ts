import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { transferInputSchema } from '@/lib/validation/inventory';
import { transferInventory } from '@/server/services/movements';

// TODO: wire requirePermission() once lib/permissions exists
// TODO: wire audit() once lib/audit exists

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = transferInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const variant = await db.productVariant.findFirst({
    where: { id: parsed.data.variantId, deletedAt: null },
  });
  if (!variant) {
    return NextResponse.json({ error: 'variant not found' }, { status: 404 });
  }

  const fromWarehouse = await db.warehouse.findFirst({
    where: { id: parsed.data.fromWarehouseId, deletedAt: null },
  });
  if (!fromWarehouse) {
    return NextResponse.json(
      { error: 'fromWarehouse not found' },
      { status: 404 },
    );
  }

  const toWarehouse = await db.warehouse.findFirst({
    where: { id: parsed.data.toWarehouseId, deletedAt: null },
  });
  if (!toWarehouse) {
    return NextResponse.json(
      { error: 'toWarehouse not found' },
      { status: 404 },
    );
  }

  try {
    const result = await transferInventory(db, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Insufficient stock')) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
