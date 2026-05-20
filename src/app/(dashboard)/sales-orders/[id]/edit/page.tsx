import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listCustomers } from '@/server/services/customers';
import { listWarehouses } from '@/server/services/warehouse';
import { listSalesReps } from '@/server/services/salesReps';
import { getActor } from '@/lib/permissions/getActor';
import { salesOrderScopeWhere } from '@/lib/permissions/scope';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatStatusLabel } from '@/lib/format';
import {
  OrderForm,
  type OrderFormValues,
} from '../../_components/order-form';
import { AddLinesForm } from './_components/add-lines-form';

export const revalidate = 0;

export default async function EditSalesOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const so = await db.salesOrder.findFirst({
    where: { AND: [{ id, deletedAt: null }, salesOrderScopeWhere(actor)] },
    include: {
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              sku: true,
              name: true,
              product: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      warehouse: { select: { id: true, code: true } },
    },
  });
  if (!so) notFound();

  // CONFIRMED → render the add-only form. Existing lines are
  // read-only (qty/price locked) per the spec; new lines reserve
  // inventory immediately via addSalesOrderLines.
  if (so.status === 'CONFIRMED') {
    return <ConfirmedEditView so={so} />;
  }

  // updateSalesOrder rejects anything past DRAFT. Render a friendly
  // "not editable" card with a link back to the detail page instead
  // of letting the operator scribble in a doomed form.
  if (so.status !== 'DRAFT') {
    return <NotEditable salesOrderId={so.id} number={so.number} status={so.status} />;
  }

  const existingVariantIds = so.lines.map((l) => l.variantId);

  const [customers, warehouses, salesReps, variants, inventoryRows] =
    await Promise.all([
      listCustomers(db, { active: true, take: 1000 }),
      listWarehouses(db),
      listSalesReps(db, { active: true }),
    // Active variants + any inactive variants the existing lines
    // reference (so historical SKUs still render in the dropdown).
    db.productVariant.findMany({
      where: {
        OR: [
          {
            active: true,
            deletedAt: null,
            product: { active: true, deletedAt: null },
          },
          ...(existingVariantIds.length > 0
            ? [{ id: { in: existingVariantIds } }]
            : []),
        ],
      },
      include: {
        product: {
          select: {
            name: true,
            basePrice: true,
            sku: true,
            shortDescription: true,
          },
        },
      },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
    // Stock context for the SKU dropdown (QOH + reserved at the SO's
    // warehouse). Pull across all warehouses; the form looks up by
    // (variantId, warehouseId) at render time.
    db.inventoryItem.findMany({
      select: {
        variantId: true,
        warehouseId: true,
        onHand: true,
        reserved: true,
      },
    }),
  ]);

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

  const defaults: Partial<OrderFormValues> = {
    customerId: so.customerId,
    warehouseId: so.warehouseId,
    customerPo: so.customerPo ?? '',
    promisedShipDate: so.promisedShipDate
      ? toDateInputValue(so.promisedShipDate)
      : '',
    shippingAddress: so.shippingAddress ?? '',
    customerNotes: so.customerNotes ?? '',
    internalNotes: so.internalNotes ?? '',
    orderDiscountPercent: so.orderDiscountPercent?.toString() ?? '',
    orderDiscountAmount: so.orderDiscountAmount?.toString() ?? '',
    shippingAmount: so.shippingAmount?.toString() ?? '',
    handlingAmount: so.handlingAmount?.toString() ?? '',
    lines: so.lines.map((l) => ({
      variantId: l.variantId,
      qtyOrdered: l.qtyOrdered.toString(),
      // Pre-fill manualUnitPrice ONLY when the original price came from
      // a manual override. For resolver-derived rules (BASE / TIER /
      // CUSTOMER_SPECIFIC / …) leave it blank so save re-runs the
      // resolver and picks up any pricing changes since the draft.
      manualUnitPrice:
        l.priceRule === 'MANUAL_OVERRIDE' ? l.unitPrice.toString() : '',
      discountPercent: l.discountPercent?.toString() ?? '',
      discountAmount: l.discountAmount?.toString() ?? '',
      customerNote: l.customerNote ?? '',
    })),
  };
  // Pre-select the per-order rep override when set; otherwise the form
  // defaults to "Customer default" (inherit).
  if (so.salesRepId) defaults.salesRepId = so.salesRepId;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/sales-orders/${so.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {so.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit order</h1>
          <p className="text-sm text-muted-foreground">
            Drafts only. Confirming this order will lock pricing and reserve
            inventory.
          </p>
        </div>
      </div>

      <OrderForm
        mode={{ kind: 'edit', salesOrderId: so.id }}
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
          shortDescription: v.product.shortDescription,
          basePrice: v.product.basePrice?.toString() ?? null,
          inventoryByWarehouse: stockByVariant.get(v.id) ?? {},
        }))}
        salesReps={salesReps.map((r) => ({ id: r.id, name: r.name }))}
        defaultValues={defaults}
      />
    </div>
  );
}

// =============================================================================
// CONFIRMED branch — add-only line editor. Pulls the same active variants
// the create form uses (no inventory-by-warehouse lookup is needed — the
// add path picks the SO's warehouse implicitly).
// =============================================================================

async function ConfirmedEditView({
  so,
}: {
  so: Awaited<ReturnType<typeof loadConfirmedSo>>;
}) {
  // Active variants only — no need to surface historical/archived ones
  // since we're adding fresh lines. Existing lines render from the
  // included relation directly so archived variants on legacy lines
  // still display.
  const variants = await db.productVariant.findMany({
    where: {
      active: true,
      deletedAt: null,
      product: { active: true, deletedAt: null },
    },
    include: {
      product: {
        select: { name: true, basePrice: true, shortDescription: true },
      },
    },
    orderBy: { sku: 'asc' },
    take: 1000,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/sales-orders/${so.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {so.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Add lines to confirmed order
          </h1>
          <p className="text-sm text-muted-foreground">
            Existing lines are locked once an order is confirmed. New lines
            reserve inventory immediately — reprint the pick sheet if the
            warehouse has already started picking.
          </p>
        </div>
      </div>

      <AddLinesForm
        salesOrderId={so.id}
        salesOrderNumber={so.number}
        warehouseId={so.warehouse.id}
        warehouseCode={so.warehouse.code}
        existingLines={so.lines.map((l) => ({
          id: l.id,
          sku: l.variant.sku,
          productName: l.variant.product.name,
          variantName: l.variant.name,
          qtyOrdered: l.qtyOrdered.toString(),
          qtyReserved: l.qtyReserved.toString(),
          unitPrice: l.unitPrice.toString(),
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          productName: v.product.name,
          variantName: v.name,
          shortDescription: v.product.shortDescription,
          basePrice: v.product.basePrice?.toString() ?? null,
        }))}
      />
    </div>
  );
}

// Helper so ConfirmedEditView's `so` prop can be typed without manually
// re-spelling the include shape. Plain function (not declared async)
// so the Awaited<ReturnType> inference works.
function loadConfirmedSo() {
  return db.salesOrder.findFirstOrThrow({
    include: {
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              sku: true,
              name: true,
              product: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      warehouse: { select: { id: true, code: true } },
    },
  });
}

function NotEditable({
  salesOrderId,
  number,
  status,
}: {
  salesOrderId: string;
  number: string;
  status: string;
}) {
  return (
    <div className="space-y-6">
      <Link
        href={`/sales-orders/${salesOrderId}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {number}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Not editable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This order is{' '}
            <span className="font-medium text-foreground">
              {formatStatusLabel(status)}
            </span>
            . Only drafts can be edited; to revise a confirmed order you
            cancel it and create a new one.
          </p>
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/sales-orders/${salesOrderId}`} />}
          >
            Back to order
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Date → YYYY-MM-DD in local time (matches the format the form's
// native <input type="date"> emits on the create path).
function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
