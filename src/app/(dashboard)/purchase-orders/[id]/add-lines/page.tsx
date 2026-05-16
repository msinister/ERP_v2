import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listWarehouses } from '@/server/services/warehouse';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatStatusLabel } from '@/lib/format';
import { AddLinesForm } from './_components/add-lines-form';

export const revalidate = 0;

export default async function AddPoLinesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const po = await db.purchaseOrder.findFirst({
    where: { id, deletedAt: null },
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
          warehouse: { select: { code: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!po) notFound();

  // DRAFT belongs on the wholesale Edit form. CLOSED + CANCELLED have
  // no editable surface — render a "not editable" card matching the
  // SO pattern.
  if (po.status === 'DRAFT') {
    redirect(`/purchase-orders/${po.id}/edit`);
  }
  if (po.status !== 'CONFIRMED' && po.status !== 'PARTIALLY_RECEIVED') {
    return (
      <NotEditable
        purchaseOrderId={po.id}
        number={po.number}
        status={po.status}
      />
    );
  }

  // Default warehouse for new draft rows: first existing line's
  // warehouse (POs in pilot are single-warehouse). If somehow no lines
  // remain, fall back to the first active warehouse.
  const existingWarehouseId = po.lines[0]?.warehouseId ?? null;

  const [warehouses, variants] = await Promise.all([
    listWarehouses(db),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: { product: { select: { name: true } } },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
  ]);

  const defaultWarehouseId = existingWarehouseId ?? warehouses[0]?.id ?? '';

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/purchase-orders/${po.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {po.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Add lines to PO
          </h1>
          <p className="text-sm text-muted-foreground">
            New lines start unreceived. Existing receipt history isn&apos;t
            affected.
          </p>
        </div>
      </div>

      <AddLinesForm
        purchaseOrderId={po.id}
        purchaseOrderNumber={po.number}
        defaultWarehouseId={defaultWarehouseId}
        currency={po.currency ?? 'USD'}
        existingLines={po.lines.map((l) => ({
          id: l.id,
          sku: l.variant.sku,
          productName: l.variant.product.name,
          variantName: l.variant.name,
          warehouseCode: l.warehouse.code,
          qtyOrdered: l.qtyOrdered.toString(),
          qtyReceived: l.qtyReceived.toString(),
          unitCost: l.unitCost.toString(),
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          productName: v.product.name,
          variantName: v.name,
        }))}
        warehouses={warehouses.map((w) => ({
          id: w.id,
          code: w.code,
          name: w.name,
        }))}
      />
    </div>
  );
}

function NotEditable({
  purchaseOrderId,
  number,
  status,
}: {
  purchaseOrderId: string;
  number: string;
  status: string;
}) {
  return (
    <div className="space-y-6">
      <Link
        href={`/purchase-orders/${purchaseOrderId}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {number}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lines can&apos;t be added</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This PO is{' '}
            <span className="font-medium text-foreground">
              {formatStatusLabel(status)}
            </span>
            . To add lines, reopen the PO first.
          </p>
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/purchase-orders/${purchaseOrderId}`} />}
          >
            Back to PO
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
