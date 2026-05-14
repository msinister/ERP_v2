import Link from 'next/link';
import { Plus } from 'lucide-react';
import {
  BillPaymentStatus,
  BillSource,
  BillStatus,
} from '@/generated/tenant';
import { db } from '@/lib/db';
import { listBillsPaged } from '@/server/services/bills';
import { listVendors } from '@/server/services/vendors';
import { Button } from '@/components/ui/button';
import { BillsFilters, type VendorOption } from './_components/filters';
import { BillsTable, type BillRowData } from './_components/table';
import { BillsPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isBillStatus(v: string | undefined): v is BillStatus {
  if (!v) return false;
  return Object.values(BillStatus).includes(v as BillStatus);
}

function isBillPaymentStatus(v: string | undefined): v is BillPaymentStatus {
  if (!v) return false;
  return Object.values(BillPaymentStatus).includes(v as BillPaymentStatus);
}

function isBillSource(v: string | undefined): v is BillSource {
  if (!v) return false;
  return Object.values(BillSource).includes(v as BillSource);
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

export default async function BillsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isBillStatus(statusRaw) ? statusRaw : undefined;
  const paymentStatusRaw = pickString(sp.paymentStatus);
  const paymentStatus = isBillPaymentStatus(paymentStatusRaw)
    ? paymentStatusRaw
    : undefined;
  const sourceRaw = pickString(sp.source);
  const source = isBillSource(sourceRaw) ? sourceRaw : undefined;
  const vendorId = pickString(sp.vendorId);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [vendors, page] = await Promise.all([
    // Active vendors only in the filter dropdown — historical bills for
    // deactivated vendors still render via the vendor join.
    listVendors(db, { active: true, take: 1000 }),
    listBillsPaged(db, {
      q,
      status,
      paymentStatus,
      source,
      vendorId,
      billDateFrom: dateFrom,
      billDateTo: dateTo,
      skip,
      take,
    }),
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    label: `${v.name} (${v.code})`,
  }));

  const tableRows: BillRowData[] = page.rows.map((b) => ({
    id: b.id,
    number: b.number,
    vendorId: b.vendor.id,
    vendorCode: b.vendor.code,
    vendorName: b.vendor.name,
    vendorReference: b.vendorReference,
    billDate: b.billDate,
    dueDate: b.dueDate,
    status: b.status,
    paymentStatus: b.paymentStatus,
    source: b.source,
    total: b.total,
    // Balance = total − amountPaid − amountCredited. The denorms are
    // recomputed by the service on every payment/credit movement.
    balance: b.total.minus(b.amountPaid).minus(b.amountCredited),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
          <p className="text-sm text-muted-foreground">
            Draft → Confirmed → Cancelled. Payment status reflects amount
            paid + credit applied against the bill total.
          </p>
        </div>
        <Button render={<Link href="/bills/new" />}>
          <Plus />
          New bill
        </Button>
      </div>

      <BillsFilters vendors={vendorOptions} />

      <BillsTable rows={tableRows} />

      <BillsPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
