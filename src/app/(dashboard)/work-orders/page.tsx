import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { Prisma, WorkOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listWorkOrdersPaged } from '@/server/services/workOrders';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatStatusLabel } from '@/lib/format';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isWorkOrderStatus(v: string | undefined): v is WorkOrderStatus {
  if (!v) return false;
  return Object.values(WorkOrderStatus).includes(v as WorkOrderStatus);
}

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const statusRaw = pickString(sp.status);
  const status = isWorkOrderStatus(statusRaw) ? statusRaw : undefined;

  const page = await listWorkOrdersPaged(db, {
    status,
    take: DEFAULT_PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Work Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Build assembled products from BOM components. Draft → In progress →
            Completed.
          </p>
        </div>
      </div>

      <StatusTabs current={status} />

      {page.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          <Wrench className="mx-auto mb-2 size-6 opacity-50" />
          No work orders {status ? `in ${formatStatusLabel(status)}` : 'yet'}.
          Open an Assembled product&apos;s detail page and click Build to
          create one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Number</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((wo) => (
                <TableRow key={wo.id}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/work-orders/${wo.id}`}
                      className="hover:underline"
                    >
                      {wo.number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{wo.product.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {wo.variant.sku}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {wo.warehouse.code}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(wo.qtyCompleted)} / {formatQty(wo.qtyToBuild)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={wo.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {wo.createdAt.toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function StatusTabs({ current }: { current: WorkOrderStatus | undefined }) {
  const tabs: Array<{ label: string; value: WorkOrderStatus | undefined }> = [
    { label: 'All', value: undefined },
    { label: 'Draft', value: WorkOrderStatus.DRAFT },
    { label: 'In progress', value: WorkOrderStatus.IN_PROGRESS },
    { label: 'Completed', value: WorkOrderStatus.COMPLETED },
    { label: 'Cancelled', value: WorkOrderStatus.CANCELLED },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t) => {
        const active = current === t.value;
        const href = t.value ? `/work-orders?status=${t.value}` : '/work-orders';
        return (
          <Link
            key={t.label}
            href={href}
            className={
              'border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ' +
              (active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: WorkOrderStatus }) {
  const tone: Record<WorkOrderStatus, 'default' | 'secondary' | 'outline'> = {
    DRAFT: 'outline',
    IN_PROGRESS: 'secondary',
    COMPLETED: 'default',
    CANCELLED: 'outline',
  };
  return (
    <Badge variant={tone[status]} className="text-[10px]">
      {formatStatusLabel(status)}
    </Badge>
  );
}

function formatQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
