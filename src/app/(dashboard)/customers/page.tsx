import Link from 'next/link';
import { Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { CustomerType } from '@/generated/tenant';
import { listCustomersPaged } from '@/server/services/customers';
import { listSalesReps } from '@/server/services/salesReps';
import { arBalanceForCustomer } from '@/server/services/ar';
import { Button } from '@/components/ui/button';
import { CustomersFilters, type SalesRepOption } from './_components/filters';
import { CustomersTable, type CustomerRowData } from './_components/table';
import { CustomersPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isCustomerType(v: string | undefined): v is CustomerType {
  if (!v) return false;
  return Object.values(CustomerType).includes(v as CustomerType);
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const typeRaw = pickString(sp.type);
  const type = isCustomerType(typeRaw) ? typeRaw : undefined;
  const activeRaw = pickString(sp.active);
  // No param = the UX default (active only). 'all' = no filter; 'false'
  // = inactive only. Anything else gets coerced back to the default.
  const active =
    activeRaw === 'all'
      ? undefined
      : activeRaw === 'false'
        ? false
        : true;
  const salesRepId = pickString(sp.salesRepId);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [salesReps, page] = await Promise.all([
    listSalesReps(db, { active: true }),
    listCustomersPaged(db, { q, type, active, salesRepId, skip, take }),
  ]);

  // Resolve sales-rep names off the rep list rather than re-querying
  // per row. Inactive reps assigned to a customer still need to render,
  // so a fall-through label catches the gap.
  const repName = new Map(salesReps.map((r) => [r.id, r.name]));
  const repOptions: SalesRepOption[] = salesReps.map((r) => ({
    id: r.id,
    label: r.name,
  }));

  // Per-row AR balance — N+1 by design; pilot scale (~40-200 rows per
  // page max) makes this acceptable. If the page grows past a few
  // hundred, replace with a single grouped aggregation.
  const balances = await Promise.all(
    page.rows.map((c) => arBalanceForCustomer(db, c.id)),
  );

  const tableRows: CustomerRowData[] = page.rows.map((c, i) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    type: c.type,
    salesRepName: repName.get(c.salesRepId) ?? '—',
    primaryPhone: c.primaryPhone,
    primaryEmail: c.primaryEmail,
    arBalance: balances[i].arBalance,
    active: c.active,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            Customer master, contacts, addresses, and pricing.
          </p>
        </div>
        <Button render={<Link href="/customers/new" />}>
          <Plus />
          New customer
        </Button>
      </div>

      <CustomersFilters salesReps={repOptions} />

      <CustomersTable rows={tableRows} />

      <CustomersPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
