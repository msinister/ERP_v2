import { Prisma, PaymentMethod, PaymentStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import {
  listPaymentsPaged,
  type PaymentSortField,
  type SortDir,
} from '@/server/services/payments';
import { listCustomers } from '@/server/services/customers';
import { listSalesReps } from '@/server/services/salesReps';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { getActor } from '@/lib/permissions/getActor';
import { customerScopeWhere, paymentScopeWhere } from '@/lib/permissions/scope';
import { redirect } from 'next/navigation';
import { PaymentsFilters, type CustomerOption } from './_components/filters';
import { PaymentsTable, type PaymentRowData } from './_components/table';
import { PaymentsPagination } from './_components/pagination';
import { RecordPaymentButton } from './_components/record-payment-button';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 20;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isPaymentStatus(v: string | undefined): v is PaymentStatus {
  return !!v && Object.values(PaymentStatus).includes(v as PaymentStatus);
}
function isPaymentMethod(v: string | undefined): v is PaymentMethod {
  return !!v && Object.values(PaymentMethod).includes(v as PaymentMethod);
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const status = isPaymentStatus(pickString(sp.status))
    ? (pickString(sp.status) as PaymentStatus)
    : undefined;
  const method = isPaymentMethod(pickString(sp.method))
    ? (pickString(sp.method) as PaymentMethod)
    : undefined;
  const customerId = pickString(sp.customerId);
  const fromParam = pickString(sp.from);
  const toParam = pickString(sp.to);
  const sortParam = pickString(sp.sort);
  const sort: PaymentSortField = sortParam === 'amount' ? 'amount' : 'receivedAt';
  const dir: SortDir = pickString(sp.dir) === 'asc' ? 'asc' : 'desc';
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = paymentScopeWhere(actor);

  const [customers, page, salesReps, paymentTerms] = await Promise.all([
    // Record-payment dialog + filter picker — scoped to the rep's own
    // customers under "view own".
    listCustomers(db, {
      active: true,
      take: 1000,
      scope: customerScopeWhere(actor),
    }),
    listPaymentsPaged(db, {
      q,
      status,
      method,
      customerId,
      receivedAtFrom: fromParam ? new Date(fromParam) : undefined,
      receivedAtTo: toParam ? new Date(`${toParam}T23:59:59.999Z`) : undefined,
      scope,
      sort,
      dir,
      skip,
      take,
    }),
    listSalesReps(db, { active: true, take: 1000 }),
    listPaymentTerms(db, { active: true }),
  ]);

  const customerOptions: CustomerOption[] = customers.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
  }));

  const rows: PaymentRowData[] = page.rows.map((p) => {
    // Applied = sum of live (non-reversed) applications. Derived rather
    // than read from Payment.appliedAmount so APPLIED_CREDIT payments
    // (whose denorm stays 0) report correctly too.
    const applied = p.applications.reduce(
      (acc, a) => (a.reversedAt ? acc : acc.plus(a.amount)),
      new Prisma.Decimal(0),
    );
    const unapplied = p.amount.minus(applied);
    // First live application whose invoice still links to an SO drives
    // the row's click-through to the source order.
    const sourceSalesOrderId =
      p.applications.find((a) => !a.reversedAt && a.invoice.salesOrderId)
        ?.invoice.salesOrderId ?? null;
    return {
      id: p.id,
      number: p.number,
      receivedAt: p.receivedAt,
      customerId: p.customer.id,
      customerCode: p.customer.code,
      customerName: p.customer.name,
      method: p.method,
      reference: p.reference,
      // Convert Decimals to numbers for the client table — Prisma.Decimal
      // loses its methods across the RSC boundary. Precision is retained
      // in the derivation above; this is a display/comparison value.
      amount: p.amount.toNumber(),
      applied: applied.toNumber(),
      unapplied: unapplied.toNumber(),
      status: p.status,
      sourceSalesOrderId,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
          <p className="text-sm text-muted-foreground">
            Customer payments received. Apply to invoices, reverse, and
            track unapplied credit sitting on customer accounts.
          </p>
        </div>
        <RecordPaymentButton
          customers={customerOptions}
          salesReps={salesReps.map((r) => ({ id: r.id, name: r.name }))}
          paymentTerms={paymentTerms.map((t) => ({
            id: t.id,
            label:
              t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
          }))}
          defaultSalesRepId={actor.salesRepId}
        />
      </div>

      <PaymentsFilters customers={customerOptions} />

      <PaymentsTable rows={rows} />

      <PaymentsPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
