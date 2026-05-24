import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Prisma, PurchaseOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listPurchaseOrdersPaged } from '@/server/services/purchaseOrders';
import { listVendors } from '@/server/services/vendors';
import { rollupShipmentStatus } from '@/lib/po/shipmentRollup';
import { Button } from '@/components/ui/button';
import {
  PurchaseOrdersFilters,
  type VendorOption,
} from './_components/filters';
import {
  PurchaseOrdersTable,
  type PurchaseOrderRowData,
} from './_components/table';
import { PurchaseOrdersPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isPurchaseOrderStatus(
  v: string | undefined,
): v is PurchaseOrderStatus {
  if (!v) return false;
  return Object.values(PurchaseOrderStatus).includes(v as PurchaseOrderStatus);
}

function parseDateInput(
  v: string | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isPurchaseOrderStatus(statusRaw) ? statusRaw : undefined;
  const vendorId = pickString(sp.vendorId);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;
  // Only 'balance' is a non-default sort (computed; sorted in-memory by the
  // service). Anything else falls through to the default createdAt desc.
  const sort = pickString(sp.sort) === 'balance' ? ('balance' as const) : undefined;
  const dir = pickString(sp.dir) === 'asc' ? ('asc' as const) : ('desc' as const);

  const [vendors, page] = await Promise.all([
    // Active vendors only in the filter dropdown — historical POs for
    // deactivated vendors still render via the vendor join.
    listVendors(db, { active: true, take: 1000 }),
    listPurchaseOrdersPaged(db, {
      q,
      status,
      vendorId,
      dateFrom,
      dateTo,
      sort,
      dir,
      skip,
      take,
    }),
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    label: `${v.name} (${v.code})`,
  }));

  const tableRows: PurchaseOrderRowData[] = page.rows.map((po) => {
    const total = po.lines.reduce(
      (acc, l) => acc.plus(l.qtyOrdered.times(l.unitCost)),
      new Prisma.Decimal(0),
    );
    const paid = po.payments.reduce(
      (acc, p) => acc.plus(p.amount),
      new Prisma.Decimal(0),
    );
    return {
      id: po.id,
      number: po.number,
      vendorId: po.vendor.id,
      vendorCode: po.vendor.code,
      vendorName: po.vendor.name,
      orderDate: po.createdAt,
      expectedReceiveDate: po.expectedReceiveDate,
      status: po.status,
      lineCount: po.lines.length,
      total,
      shipmentRollup: rollupShipmentStatus(
        po.shipments.map((s) => s.shipmentStatus),
      ),
      paid: paid.toString(),
      hasPayments: po.payments.length > 0,
      // Remaining balance = line total − recorded payments/deposits.
      balance: total.minus(paid).toString(),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Purchase Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Draft → Confirmed → Partially received → Closed.
          </p>
        </div>
        <Button render={<Link href="/purchase-orders/new" />}>
          <Plus />
          New PO
        </Button>
      </div>

      <PurchaseOrdersFilters vendors={vendorOptions} />

      <PurchaseOrdersTable rows={tableRows} />

      <PurchaseOrdersPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
