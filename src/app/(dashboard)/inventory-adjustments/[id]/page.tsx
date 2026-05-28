import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { getAdjustment } from '@/server/services/inventoryAdjustments';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency } from '@/lib/format';
import { categoryLabel } from '../_components/categories';
import { VoidAdjustmentAction } from './_components/void-action';

export const revalidate = 0;

export default async function AdjustmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('inventory_adjustments.view');
  const { id } = await params;
  const adj = await getAdjustment(db, id);
  if (!adj) notFound();

  const creator = adj.createdById
    ? await db.user.findUnique({
        where: { id: adj.createdById },
        select: { name: true },
      })
    : null;

  const totalValue = adj.lines.reduce(
    (acc, l) => acc.plus(l.qtyChange.abs().times(l.unitCost)),
    new Prisma.Decimal(0),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/inventory-adjustments"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Inventory Adjustments
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {adj.number}
              </h1>
              <StatusBadge entityType="InventoryAdjustment" status={adj.status} />
              <Badge variant="outline" className="text-muted-foreground">
                {categoryLabel(adj.category)}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                <span className="font-medium text-foreground/80">Date</span>{' '}
                {formatDate(adj.adjustmentDate)}
              </span>
              <span>
                <span className="font-medium text-foreground/80">Warehouse</span>{' '}
                <span className="font-mono">{adj.warehouse.code}</span>{' '}
                {adj.warehouse.name}
              </span>
              {adj.voidedAt ? (
                <span>
                  <span className="font-medium text-foreground/80">Voided</span>{' '}
                  {formatDate(adj.voidedAt)}
                </span>
              ) : null}
            </div>
          </div>
          {adj.status === 'POSTED' ? (
            <VoidAdjustmentAction adjustmentId={adj.id} number={adj.number} />
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Lines</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead className="pl-6">SKU</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Qty change</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Total value</TableHead>
                    <TableHead className="pr-6">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {adj.lines.map((l) => {
                    const qty = l.qtyChange;
                    const value = qty.abs().times(l.unitCost);
                    const isLoss = qty.lessThan(0);
                    return (
                      <TableRow key={l.id}>
                        <TableCell className="pl-6 font-mono text-xs">
                          {l.variant.sku}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {l.variant.product.name}
                          </div>
                          {l.variant.name ? (
                            <div className="text-xs text-muted-foreground">
                              {l.variant.name}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell
                          className={
                            'text-right tabular-nums font-medium ' +
                            (isLoss ? 'text-destructive' : 'text-green-600')
                          }
                        >
                          {isLoss ? '' : '+'}
                          {formatQty(qty)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(l.unitCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(value)}
                        </TableCell>
                        <TableCell className="pr-6 text-xs text-muted-foreground">
                          {l.notes ?? '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Reason
                </div>
                <p className="whitespace-pre-line">{adj.reason}</p>
              </div>
              {adj.internalNotes ? (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Internal notes
                  </div>
                  <p className="whitespace-pre-line text-muted-foreground">
                    {adj.internalNotes}
                  </p>
                </div>
              ) : null}
              {adj.voidReason ? (
                <div className="rounded border border-destructive/30 bg-destructive/5 p-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
                    Void reason
                  </div>
                  <p className="whitespace-pre-line text-muted-foreground">
                    {adj.voidReason}
                  </p>
                </div>
              ) : null}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Created by
                </div>
                <p>{creator?.name ?? '—'}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Lines</dt>
                  <dd className="tabular-nums">{adj.lines.length}</dd>
                </div>
                <div className="my-2 border-t" />
                <div className="flex items-center justify-between gap-3">
                  <dt className="font-medium">Total value</dt>
                  <dd className="text-base font-semibold tabular-nums">
                    {formatCurrency(totalValue)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
