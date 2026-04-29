import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { receiveInputSchema } from '@/lib/validation/inventory';
import { receiveInventory } from '@/server/services/movements';

// TODO: wire requirePermission() once lib/permissions exists
// TODO: wire audit() once lib/audit exists

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = receiveInputSchema.safeParse(body);
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

  const warehouse = await db.warehouse.findFirst({
    where: { id: parsed.data.warehouseId, deletedAt: null },
  });
  if (!warehouse) {
    return NextResponse.json({ error: 'warehouse not found' }, { status: 404 });
  }

  try {
    const movement = await receiveInventory(db, parsed.data);
    return NextResponse.json(movement, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
