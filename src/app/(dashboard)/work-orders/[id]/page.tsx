import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getWorkOrder } from '@/server/services/workOrders';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { WorkOrderLifecycleActions } from './_components/lifecycle-actions';

export const revalidate = 0;

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const wo = await getWorkOrder(db, id);
  if (!wo) notFound();

  // Pre-join product + warehouse + variant for the header.
  const [product, variant, warehouse] = await Promise.all([
    db.product.findUniqueOrThrow({
      where: { id: wo.productId },
      select: { id: true, sku: true, name: true },
    }),
    db.productVariant.findUniqueOrThrow({
      where: { id: wo.variantId },
      select: { id: true, sku: true, name: true },
    }),
    db.warehouse.findUniqueOrThrow({
      where: { id: wo.warehouseId },
      select: { id: true, code: true, name: true },
    }),
  ]);

  // Stock availability per component, at the WO's warehouse, against
  // the per-event total needed (qtyRequiredPerUnit × remaining).
  // Operators see real-time shortage so they can pick a workable
  // qtyToComplete.
  const remaining = wo.qtyToBuild.minus(wo.qtyCompleted);
  const componentVariantIds = wo.components.map((c) => c.componentVariantId);
  const stockRows = await db.inventoryItem.findMany({
    where: {
      variantId: { in: componentVariantIds },
      warehouseId: wo.warehouseId,
    },
    select: { variantId: true, onHand: true },
  });
  const stockByVariant = new Map(
    stockRows.map((r) => [r.variantId, r.onHand]),
  );

  type ComponentRow = {
    id: string;
    componentVariantId: string;
    componentVariantSku: string;
    componentProductName: string;
    qtyRequiredPerUnit: Prisma.Decimal;
    qtyRequiredForRemaining: Prisma.Decimal;
    available: Prisma.Decimal;
    shortage: Prisma.Decimal;
  };
  const componentRows: ComponentRow[] = wo.components.map((c) => {
    const required = c.qtyRequiredPerUnit.times(remaining);
    const available = stockByVariant.get(c.componentVariantId) ?? new Prisma.Decimal(0);
    const shortage = required.greaterThan(available)
      ? required.minus(available)
      : new Prisma.Decimal(0);
    return {
      id: c.id,
      componentVariantId: c.componentVariantId,
      componentVariantSku: c.componentVariant.sku,
      componentProductName: c.componentVariant.name ?? c.componentVariant.sku,
      qtyRequiredPerUnit: c.qtyRequiredPerUnit,
      qtyRequiredForRemaining: required,
      available,
      shortage,
    };
  });

  const anyShortage = componentRows.some((r) => r.shortage.greaterThan(0));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/work-orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Work orders
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-baseline gap-3">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {wo.number}
              </h1>
              <StatusBadge status={wo.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              Build {formatQty(wo.qtyToBuild)} × {product.name}{' '}
              <span className="font-mono text-xs">({variant.sku})</span> at{' '}
              <span className="font-mono">{warehouse.code}</span>
            </p>
          </div>
          <WorkOrderLifecycleActions
            workOrderId={wo.id}
            number={wo.number}
            status={wo.status}
            qtyToBuild={wo.qtyToBuild.toString()}
            qtyCompleted={wo.qtyCompleted.toString()}
            remaining={remaining.toString()}
            anyShortage={anyShortage}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Component requirements{' '}
                {remaining.greaterThan(0) ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    (for remaining {formatQty(remaining)} units)
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {componentRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No components.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead>SKU</TableHead>
                      <TableHead>Component</TableHead>
                      <TableHead className="text-right">Per unit</TableHead>
                      <TableHead className="text-right">Required</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Shortage</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {componentRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {r.componentVariantSku}
                        </TableCell>
                        <TableCell>{r.componentProductName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(r.qtyRequiredPerUnit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(r.qtyRequiredForRemaining)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(r.available)}
                        </TableCell>
                        <TableCell
                          className={
                            'text-right tabular-nums ' +
                            (r.shortage.greaterThan(0)
                              ? 'font-medium text-destructive'
                              : 'text-muted-foreground')
                          }
                        >
                          {r.shortage.greaterThan(0)
                            ? formatQty(r.shortage)
                            : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Completion history</CardTitle>
            </CardHeader>
            <CardContent>
              {wo.completions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No completions yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead>When</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit cost</TableHead>
                      <TableHead className="text-right">Labor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {wo.completions.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.createdAt.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(c.qtyCompleted)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(c.unitCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(c.totalLaborCost)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Qty to build" value={formatQty(wo.qtyToBuild)} />
              <Row label="Completed" value={formatQty(wo.qtyCompleted)} />
              <Row label="Remaining" value={formatQty(remaining)} />
              <Row
                label="Labor per unit"
                value={
                  wo.laborCost != null
                    ? formatCurrency(wo.laborCost)
                    : '—'
                }
              />
              {wo.startedAt ? (
                <Row
                  label="Started"
                  value={wo.startedAt.toLocaleString()}
                />
              ) : null}
              {wo.completedAt ? (
                <Row
                  label="Completed at"
                  value={wo.completedAt.toLocaleString()}
                />
              ) : null}
              {wo.cancelledAt ? (
                <Row
                  label="Cancelled at"
                  value={wo.cancelledAt.toLocaleString()}
                />
              ) : null}
            </CardContent>
          </Card>
          {wo.cancelReason ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Cancel reason</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm italic text-muted-foreground">
                  &ldquo;{wo.cancelReason}&rdquo;
                </p>
              </CardContent>
            </Card>
          ) : null}
          {wo.notes ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {wo.notes}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, 'default' | 'secondary' | 'outline'> = {
    DRAFT: 'outline',
    IN_PROGRESS: 'secondary',
    COMPLETED: 'default',
    CANCELLED: 'outline',
  };
  return (
    <Badge variant={tone[status] ?? 'outline'} className="text-[10px]">
      {formatStatusLabel(status)}
    </Badge>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
