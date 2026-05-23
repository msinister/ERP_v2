import Link from 'next/link';
import { ChevronLeft, ClipboardCheck, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { LifecycleActions } from './lifecycle-actions';

export type PurchaseOrderHeaderProps = {
  po: {
    id: string;
    number: string;
    status: string;
    vendor: { id: string; code: string; name: string };
    orderDate: Date;
    confirmedAt: Date | null;
    closedAt: Date | null;
    cancelledAt: Date | null;
    // Rolled-up shipment status across the PO's shipments, or null when
    // there are none. Rendered as a second badge beside the PO status.
    shipmentRollup: string | null;
  };
};

export function PurchaseOrderHeader({ po }: PurchaseOrderHeaderProps) {
  return (
    <div className="space-y-3">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Purchase Orders
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {po.number}
            </h1>
            <StatusBadge entityType="PurchaseOrder" status={po.status} />
            {po.shipmentRollup ? (
              <StatusBadge
                entityType="PoShipment"
                status={po.shipmentRollup}
              />
            ) : null}
          </div>
          <div className="text-sm text-muted-foreground">
            <Link
              href={`/vendors/${po.vendor.id}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {po.vendor.name}
            </Link>
            <span className="px-2 text-muted-foreground/60">·</span>
            <span className="font-mono text-xs">{po.vendor.code}</span>
          </div>
          <DateLine
            orderDate={po.orderDate}
            confirmedAt={po.confirmedAt}
            closedAt={po.closedAt}
            cancelledAt={po.cancelledAt}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                href={`/print/purchase-order/${po.id}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <Printer />
            Print PO
          </Button>
          {/* Pre-receiving warehouse count sheet — only meaningful once
              the PO is signaled to the vendor (CONFIRMED) and while it's
              still being received (PARTIALLY_RECEIVED). */}
          {po.status === 'CONFIRMED' || po.status === 'PARTIALLY_RECEIVED' ? (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/print/purchase-orders/${po.id}/check-in`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <ClipboardCheck />
              Check-in Sheet
            </Button>
          ) : null}
          <LifecycleActions
            purchaseOrderId={po.id}
            purchaseOrderNumber={po.number}
            status={po.status}
          />
        </div>
      </div>
    </div>
  );
}

function DateLine({
  orderDate,
  confirmedAt,
  closedAt,
  cancelledAt,
}: {
  orderDate: Date;
  confirmedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
}) {
  const parts: Array<{ label: string; date: Date }> = [
    { label: 'Ordered', date: orderDate },
  ];
  if (confirmedAt) parts.push({ label: 'Confirmed', date: confirmedAt });
  if (closedAt) parts.push({ label: 'Closed', date: closedAt });
  if (cancelledAt) parts.push({ label: 'Cancelled', date: cancelledAt });
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {parts.map((p, idx) => (
        <span key={idx}>
          <span className="font-medium text-foreground/80">{p.label}</span>{' '}
          {formatDate(p.date)}
        </span>
      ))}
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
