import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Prisma, RmaStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listRmasPaged } from '@/server/services/rmas';
import { listCustomers } from '@/server/services/customers';
import { Button } from '@/components/ui/button';
import {
  RmasFilters,
  type CustomerOption,
} from './_components/filters';
import { RmasTable, type RmaRowData } from './_components/table';
import { RmasPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isRmaStatus(v: string | undefined): v is RmaStatus {
  if (!v) return false;
  return Object.values(RmaStatus).includes(v as RmaStatus);
}

export default async function RmasPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const statusRaw = pickString(sp.status);
  const status = isRmaStatus(statusRaw) ? statusRaw : undefined;
  const customerId = pickString(sp.customerId);
  const fromParam = pickString(sp.from);
  const toParam = pickString(sp.to);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [customers, page] = await Promise.all([
    listCustomers(db, { active: true, take: 1000 }),
    listRmasPaged(db, {
      status,
      customerId,
      createdAtFrom: fromParam ? new Date(fromParam) : undefined,
      createdAtTo: toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined,
      skip,
      take,
    }),
  ]);

  const customerOptions: CustomerOption[] = customers.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
  }));

  const zero = new Prisma.Decimal(0);
  const tableRows: RmaRowData[] = page.rows.map((r) => {
    // Total = sum(line.qty × invoiceLine.unitPrice) — gross dollar value
    // of the requested return. Restocking fee not subtracted here; the
    // detail page surfaces both gross and net.
    let total = zero;
    for (const l of r.lines) {
      total = total.plus(l.qty.times(l.invoiceLine.unitPrice));
    }
    return {
      id: r.id,
      number: r.number,
      customerId: r.customer.id,
      customerCode: r.customer.code,
      customerName: r.customer.name,
      invoiceId: r.invoice.id,
      invoiceNumber: r.invoice.number,
      createdAt: r.createdAt,
      itemCount: r.lines.length,
      totalQty: r.lines.reduce(
        (acc, l) => acc.plus(l.qty),
        new Prisma.Decimal(0),
      ),
      total,
      status: r.status,
      returnless: r.returnless,
      hasCreditMemo: r.creditMemo != null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">RMAs</h1>
          <p className="text-sm text-muted-foreground">
            Return Merchandise Authorization. Pending Review → Approved →
            In Transit → Received → Inspected → Credited. Issuing credit
            auto-creates a Credit Memo linked to the original invoice.
          </p>
        </div>
        <Button render={<Link href="/rmas/new" />}>
          <Plus />
          New RMA
        </Button>
      </div>

      <RmasFilters customers={customerOptions} />

      <RmasTable rows={tableRows} />

      <RmasPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
