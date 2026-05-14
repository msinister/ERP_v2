import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listCustomers } from '@/server/services/customers';
import { listWarehouses } from '@/server/services/warehouse';
import { OrderForm } from '../_components/order-form';

export const revalidate = 0;

export default async function NewSalesOrderPage() {
  // Pilot scale: a few dozen customers, a few dozen variants. One fetch
  // each — no per-line API search. Both lookups exclude deleted /
  // inactive records.
  const [customers, warehouses, variants, inventoryRows] = await Promise.all([
    listCustomers(db, { active: true, take: 1000 }),
    listWarehouses(db),
    db.productVariant.findMany({
      where: { active: true, deletedAt: null, product: { active: true, deletedAt: null } },
      include: {
        product: { select: { name: true, basePrice: true, sku: true } },
      },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
    // Pull inventory across all warehouses; the form looks up by
    // (variantId, warehouseId) at render time so the SKU dropdown can
    // show QOH + available for the SO's chosen warehouse.
    db.inventoryItem.findMany({
      select: {
        variantId: true,
        warehouseId: true,
        onHand: true,
        reserved: true,
      },
    }),
  ]);

  // variantId → { warehouseId → { onHand, reserved } } as on-disk
  // strings. The form treats missing entries as 0/0.
  const stockByVariant = new Map<
    string,
    Record<string, { onHand: string; reserved: string }>
  >();
  for (const row of inventoryRows) {
    let perWarehouse = stockByVariant.get(row.variantId);
    if (!perWarehouse) {
      perWarehouse = {};
      stockByVariant.set(row.variantId, perWarehouse);
    }
    perWarehouse[row.warehouseId] = {
      onHand: row.onHand.toString(),
      reserved: row.reserved.toString(),
    };
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/sales-orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Sales Orders
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New order</h1>
          <p className="text-sm text-muted-foreground">
            Create a draft. Confirm reserves inventory and runs credit
            checks; Close consumes stock and generates an invoice.
          </p>
        </div>
      </div>

      <OrderForm
        mode={{ kind: 'create' }}
        customers={customers.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
        }))}
        warehouses={warehouses.map((w) => ({
          id: w.id,
          code: w.code,
          name: w.name,
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          variantName: v.name,
          productName: v.product.name,
          basePrice: v.product.basePrice?.toString() ?? null,
          inventoryByWarehouse: stockByVariant.get(v.id) ?? {},
        }))}
      />
    </div>
  );
}
