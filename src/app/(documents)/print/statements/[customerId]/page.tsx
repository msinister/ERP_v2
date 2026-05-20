import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo, type CompanyInfo } from '@/lib/company-info';
import { formatCurrency } from '@/lib/format';
import { agingForCustomer } from '@/server/services/ar';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';

export const revalidate = 0;

// Two statement modes selected by ?type=:
//   open      — current open-item snapshot (aging buckets + open invoices)
//   activity  — balance-forward ledger across ?from / ?to date range
//
// The activity ledger is balance-forward: every non-voided invoice is a
// debit, every non-reversed cash payment and every confirmed credit memo
// is a credit. APPLIED_CREDIT-method payments are EXCLUDED — they are the
// mechanism by which an already-counted credit memo is applied to an
// invoice, so counting both would double-credit the customer.

export default async function CustomerStatementDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { customerId } = await params;
  const sp = await searchParams;
  const type = readParam(sp, 'type') === 'activity' ? 'activity' : 'open';

  const customer = await db.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: {
      id: true,
      code: true,
      name: true,
      primaryEmail: true,
      primaryPhone: true,
      addresses: {
        where: { kind: 'BILLING', deletedAt: null, isDefault: true },
        take: 1,
      },
    },
  });
  if (!customer) notFound();

  const company = await getCompanyInfo(db);
  const billing = customer.addresses[0] ?? null;
  const billToBlock = (
    <AddressBlock
      label="Statement for"
      address={
        billing
          ? {
              name: customer.name,
              attention: billing.attention,
              line1: billing.line1,
              line2: billing.line2,
              city: billing.city,
              region: billing.region,
              postalCode: billing.postalCode,
              country: billing.country,
              phone: customer.primaryPhone,
              email: customer.primaryEmail,
            }
          : {
              name: customer.name,
              phone: customer.primaryPhone,
              email: customer.primaryEmail,
            }
      }
    />
  );

  if (type === 'activity') {
    return (
      <ActivityStatement
        customerId={customerId}
        customerCode={customer.code}
        company={company}
        billToBlock={billToBlock}
        fromRaw={readParam(sp, 'from')}
        toRaw={readParam(sp, 'to')}
      />
    );
  }

  return (
    <OpenBalanceStatement
      customerId={customerId}
      customerCode={customer.code}
      company={company}
      billToBlock={billToBlock}
    />
  );
}

// ---------------------------------------------------------------------------
// Open balance
// ---------------------------------------------------------------------------

const BUCKET_LABELS: Record<string, string> = {
  current: 'Current',
  b1to30: '1–30',
  b31to60: '31–60',
  b61to90: '61–90',
  b91plus: '91+',
};

async function OpenBalanceStatement({
  customerId,
  customerCode,
  company,
  billToBlock,
}: {
  customerId: string;
  customerCode: string;
  company: CompanyInfo;
  billToBlock: ReactNode;
}) {
  const asOf = new Date();
  const aging = await agingForCustomer(db, customerId, asOf);

  return (
    <DocumentShell
      backHref={`/customers/${customerId}`}
      backLabel="Customer"
    >
      <DocumentHeader
        company={company}
        title="Statement"
        metadata={[
          { label: 'Generated', value: formatDate(asOf) },
          { label: 'Customer', value: customerCode },
        ]}
      />

      <section className="mt-6">{billToBlock}</section>

      <section className="mt-6">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Aging summary
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-right text-[10px] uppercase tracking-wide text-muted-foreground">
              {(['current', 'b1to30', 'b31to60', 'b61to90', 'b91plus'] as const).map(
                (k) => (
                  <th key={k} className="py-2 pr-3 font-semibold">
                    {BUCKET_LABELS[k]}
                  </th>
                ),
              )}
              <th className="py-2 font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              {(['current', 'b1to30', 'b31to60', 'b61to90', 'b91plus'] as const).map(
                (k) => (
                  <td
                    key={k}
                    className="py-2 pr-3 text-right tabular-nums text-muted-foreground"
                  >
                    {formatCurrency(aging.buckets[k])}
                  </td>
                ),
              )}
              <td className="py-2 text-right tabular-nums font-semibold">
                {formatCurrency(aging.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Open invoices
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Invoice #</th>
              <th className="py-2 pr-3 font-semibold">Date</th>
              <th className="py-2 pr-3 font-semibold">Due date</th>
              <th className="py-2 pr-3 text-right font-semibold">Total</th>
              <th className="py-2 pr-3 text-right font-semibold">Paid</th>
              <th className="py-2 pr-3 text-right font-semibold">Credits</th>
              <th className="py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {aging.invoices.length === 0 ? (
              <tr className="border-b border-border">
                <td
                  colSpan={7}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  No open invoices.
                </td>
              </tr>
            ) : (
              aging.invoices.map((row) => (
                <tr key={row.invoiceId} className="border-b border-border">
                  <td className="py-2 pr-3 font-mono text-xs">{row.number}</td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {formatDate(row.invoiceDate)}
                  </td>
                  <td
                    className={
                      'py-2 pr-3 ' +
                      (row.daysPastDue > 0
                        ? 'font-medium text-destructive'
                        : 'text-muted-foreground')
                    }
                  >
                    {formatDate(row.dueDate)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(row.total)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(row.amountPaid)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(row.amountCredited)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatCurrency(row.balance)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {aging.unappliedCreditBalance.greaterThan(0) ? (
        <section className="mt-6 rounded border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Unapplied credits / deposits
            </span>
            <span className="tabular-nums font-medium">
              {formatCurrency(aging.unappliedCreditBalance)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Credit available to apply against future or open invoices.
          </p>
        </section>
      ) : null}

      <section className="mt-8 flex justify-end">
        <div className="w-full max-w-[320px] rounded-md border border-border bg-muted/30 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Total balance due
            </span>
            <span className="text-2xl font-bold tabular-nums">
              {formatCurrency(aging.total)}
            </span>
          </div>
        </div>
      </section>
    </DocumentShell>
  );
}

// ---------------------------------------------------------------------------
// Full activity (balance-forward ledger)
// ---------------------------------------------------------------------------

type ActivityEntry = {
  date: Date;
  type: 'Invoice' | 'Payment' | 'Credit';
  reference: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
};

async function ActivityStatement({
  customerId,
  customerCode,
  company,
  billToBlock,
  fromRaw,
  toRaw,
}: {
  customerId: string;
  customerCode: string;
  company: CompanyInfo;
  billToBlock: ReactNode;
  fromRaw: string | undefined;
  toRaw: string | undefined;
}) {
  const now = new Date();
  // Defaults: year-to-date. from = Jan 1 (UTC) of the current year,
  // to = today. Both clamp to day boundaries in UTC.
  const from =
    parseDate(fromRaw, false) ??
    new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  const to =
    parseDate(toRaw, true) ??
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );

  const zero = new Prisma.Decimal(0);

  const [invoices, payments, creditMemos] = await Promise.all([
    db.invoice.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { not: InvoiceStatus.VOIDED },
        invoiceDate: { lte: to },
      },
      select: { number: true, invoiceDate: true, total: true },
    }),
    db.payment.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { not: PaymentStatus.REVERSED },
        method: { not: PaymentMethod.APPLIED_CREDIT },
        receivedAt: { lte: to },
      },
      select: { number: true, receivedAt: true, amount: true },
    }),
    db.creditMemo.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: CreditMemoStatus.CONFIRMED,
      },
      select: {
        number: true,
        netCredit: true,
        issuedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const entries: ActivityEntry[] = [
    ...invoices.map((i) => ({
      date: i.invoiceDate,
      type: 'Invoice' as const,
      reference: i.number,
      debit: i.total,
      credit: zero,
    })),
    ...payments.map((p) => ({
      date: p.receivedAt,
      type: 'Payment' as const,
      reference: p.number,
      debit: zero,
      credit: p.amount,
    })),
    ...creditMemos
      .map((c) => ({
        date: c.issuedAt ?? c.createdAt,
        type: 'Credit' as const,
        reference: c.number,
        debit: zero,
        credit: c.netCredit,
      }))
      .filter((c) => c.date <= to),
  ];

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Opening balance = net of every entry strictly before the window.
  let openingBalance = zero;
  const inRange: ActivityEntry[] = [];
  for (const e of entries) {
    if (e.date < from) {
      openingBalance = openingBalance.plus(e.debit).minus(e.credit);
    } else {
      inRange.push(e);
    }
  }

  let running = openingBalance;
  const rows = inRange.map((e) => {
    running = running.plus(e.debit).minus(e.credit);
    return { entry: e, running };
  });
  const closingBalance = running;

  return (
    <DocumentShell
      backHref={`/customers/${customerId}`}
      backLabel="Customer"
    >
      <DocumentHeader
        company={company}
        title="Statement"
        metadata={[
          { label: 'Generated', value: formatDate(now) },
          { label: 'Period', value: `${formatDate(from)} – ${formatDate(to)}` },
          { label: 'Customer', value: customerCode },
        ]}
      />

      <section className="mt-6">{billToBlock}</section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Date</th>
              <th className="py-2 pr-3 font-semibold">Type</th>
              <th className="py-2 pr-3 font-semibold">Reference #</th>
              <th className="py-2 pr-3 text-right font-semibold">Debit</th>
              <th className="py-2 pr-3 text-right font-semibold">Credit</th>
              <th className="py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border bg-muted/30">
              <td className="py-2 pr-3 text-muted-foreground" colSpan={3}>
                Opening balance
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3" />
              <td className="py-2 text-right tabular-nums font-medium">
                {formatCurrency(openingBalance)}
              </td>
            </tr>
            {rows.length === 0 ? (
              <tr className="border-b border-border">
                <td
                  colSpan={6}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  No activity in this period.
                </td>
              </tr>
            ) : (
              rows.map(({ entry, running: bal }, idx) => (
                <tr key={idx} className="border-b border-border">
                  <td className="py-2 pr-3 text-muted-foreground">
                    {formatDate(entry.date)}
                  </td>
                  <td className="py-2 pr-3">{entry.type}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {entry.reference}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {entry.debit.greaterThan(0)
                      ? formatCurrency(entry.debit)
                      : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {entry.credit.greaterThan(0)
                      ? formatCurrency(entry.credit)
                      : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatCurrency(bal)}
                  </td>
                </tr>
              ))
            )}
            <tr className="border-t-2 border-border">
              <td className="py-2 pr-3 font-semibold" colSpan={3}>
                Closing balance
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3" />
              <td className="py-2 text-right tabular-nums text-base font-bold">
                {formatCurrency(closingBalance)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </DocumentShell>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readParam(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = sp[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

// Parse a YYYY-MM-DD string into a UTC instant. `endOfDay` pins it to
// 23:59:59.999 so a `to` filter is inclusive of the whole day.
function parseDate(raw: string | undefined, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ms = endOfDay
    ? Date.UTC(y, mo, d, 23, 59, 59, 999)
    : Date.UTC(y, mo, d, 0, 0, 0, 0);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
