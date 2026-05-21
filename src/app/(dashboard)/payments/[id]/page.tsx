import { notFound, redirect } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { agingForCustomer } from '@/server/services/ar';
import { getActor } from '@/lib/permissions/getActor';
import { paymentScopeWhere } from '@/lib/permissions/scope';
import { journalEntriesForEntity } from '@/server/services/reports/financial';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import {
  JournalEntriesCard,
  type JournalEntryRow,
} from '@/components/shared/journal-entries-card';
import { PaymentHeader } from './_components/header';
import { PaymentInfoCard } from './_components/info-card';
import {
  ApplicationsCard,
  type PaymentApplicationRow,
} from './_components/applications-card';
import type { OpenInvoiceOption } from './_components/actions';

export const revalidate = 0;

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');

  const payment = await db.payment.findFirst({
    where: { AND: [{ id, deletedAt: null }, paymentScopeWhere(actor)] },
    include: {
      customer: { select: { id: true, code: true, name: true } },
      applications: {
        include: {
          invoice: {
            select: { id: true, number: true, salesOrderId: true },
          },
        },
        orderBy: { appliedAt: 'asc' },
      },
    },
  });
  if (!payment) notFound();

  // Applied = sum of live applications. Derived (not Payment.appliedAmount)
  // so APPLIED_CREDIT payments — whose denorm stays 0 — report correctly.
  const applied = payment.applications.reduce(
    (acc, a) => (a.reversedAt ? acc : acc.plus(a.amount)),
    new Prisma.Decimal(0),
  );
  const unapplied = payment.amount.minus(applied);

  const applicationRows: PaymentApplicationRow[] = payment.applications.map(
    (a) => ({
      id: a.id,
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.number,
      salesOrderId: a.invoice.salesOrderId,
      amount: a.amount,
      appliedAt: a.appliedAt,
      reversedAt: a.reversedAt,
      kind: a.kind,
    }),
  );

  // Open invoices for the apply-to-invoice dialog — only needed when the
  // payment can still be applied (RECORDED, cash-funded, unapplied > 0).
  const canApply =
    payment.status === 'RECORDED' &&
    payment.method !== 'APPLIED_CREDIT' &&
    unapplied.greaterThan(0);
  const openInvoices: OpenInvoiceOption[] = canApply
    ? (await agingForCustomer(db, payment.customerId)).invoices.map((i) => ({
        invoiceId: i.invoiceId,
        number: i.number,
        balance: i.balance.toString(),
      }))
    : [];

  const journalRows: JournalEntryRow[] = (
    await journalEntriesForEntity(db, 'Payment', payment.id)
  ).map((j) => ({
    id: j.id,
    number: j.number,
    postedAt: j.postedAt,
    description: j.description,
    entityType: j.entityType,
    entityId: j.entityId,
    reversedAt: j.reversedAt,
    lines: j.lines.map((l) => ({
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      memo: l.memo,
    })),
  }));

  return (
    <div className="space-y-6">
      <PaymentHeader
        payment={{
          id: payment.id,
          number: payment.number,
          status: payment.status,
          method: payment.method,
          receivedAt: payment.receivedAt,
          reversedAt: payment.reversedAt,
          customer: payment.customer,
          unapplied: unapplied.toString(),
        }}
        openInvoices={openInvoices}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <ApplicationsCard
            paymentId={payment.id}
            paymentStatus={payment.status}
            rows={applicationRows}
          />

          <PaymentInfoCard
            method={payment.method}
            reference={payment.reference}
            currency={payment.currency ?? 'USD'}
            notes={payment.notes}
            reversedReason={payment.reversedReason}
          />

          <JournalEntriesCard entries={journalRows} />
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="text-base font-semibold tabular-nums">
                    {formatCurrency(payment.amount)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Applied</dt>
                  <dd className="tabular-nums text-muted-foreground">
                    {formatCurrency(applied)}
                  </dd>
                </div>
                <div className="my-2 border-t" />
                <div className="flex items-center justify-between gap-3">
                  <dt className="font-medium">Unapplied</dt>
                  <dd
                    className={
                      'text-base font-semibold tabular-nums ' +
                      (payment.status === 'RECORDED' && unapplied.greaterThan(0)
                        ? 'text-amber-600'
                        : '')
                    }
                  >
                    {payment.status === 'RECORDED'
                      ? formatCurrency(unapplied)
                      : '—'}
                  </dd>
                </div>
              </dl>
              {payment.status === 'RECORDED' && unapplied.greaterThan(0) ? (
                <p className="mt-3 text-xs text-amber-600">
                  Unapplied credit sitting on this customer&apos;s account.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
