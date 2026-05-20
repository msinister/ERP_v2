import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatCurrency } from '@/lib/format';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';
import { TotalsFooter, type TotalsRow } from '../../../_components/totals-footer';

export const revalidate = 0;

const METHOD_LABELS: Record<string, string> = {
  CREDIT_CARD: 'Credit card',
  ACH: 'ACH',
  WIRE: 'Wire',
  CHECK: 'Check',
  CASH: 'Cash',
  MONEY_ORDER: 'Money order',
  APPLIED_CREDIT: 'Applied credit',
};

export default async function PaymentReceiptDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const payment = await db.payment.findFirst({
    where: { id, deletedAt: null },
    include: {
      customer: {
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
      },
      applications: {
        where: { reversedAt: null },
        include: {
          invoice: {
            select: {
              id: true,
              number: true,
              total: true,
              amountPaid: true,
              amountCredited: true,
            },
          },
        },
        orderBy: { appliedAt: 'asc' },
      },
    },
  });
  if (!payment) notFound();

  const company = await getCompanyInfo(db);
  const billing = payment.customer.addresses[0] ?? null;
  const unapplied = payment.amount.minus(payment.appliedAmount);

  const totalsRows: TotalsRow[] = [
    { label: 'Payment amount', value: payment.amount.toString() },
  ];
  if (payment.appliedAmount.greaterThan(0)) {
    totalsRows.push({
      label: 'Applied to invoices',
      value: payment.appliedAmount.toString(),
      tone: 'muted',
    });
  }
  if (unapplied.greaterThan(0)) {
    totalsRows.push({
      label: 'Unapplied credit',
      value: unapplied.toString(),
      tone: 'muted',
    });
  }

  return (
    <DocumentShell
      backHref={`/customers/${payment.customer.id}`}
      backLabel={payment.customer.name}
    >
      <DocumentHeader
        company={company}
        title="Payment Receipt"
        metadata={[
          { label: 'Payment #', value: payment.number },
          { label: 'Date', value: formatDate(payment.receivedAt) },
          { label: 'Method', value: METHOD_LABELS[payment.method] ?? payment.method },
          ...(payment.reference
            ? [{ label: 'Reference', value: payment.reference }]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Received from"
          address={
            billing
              ? {
                  name: payment.customer.name,
                  attention: billing.attention,
                  line1: billing.line1,
                  line2: billing.line2,
                  city: billing.city,
                  region: billing.region,
                  postalCode: billing.postalCode,
                  country: billing.country,
                  phone: payment.customer.primaryPhone,
                  email: payment.customer.primaryEmail,
                }
              : {
                  name: payment.customer.name,
                  phone: payment.customer.primaryPhone,
                  email: payment.customer.primaryEmail,
                }
          }
        />
        <div className="space-y-2 text-sm sm:text-right">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Amount received
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {formatCurrency(payment.amount)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Customer code
            </div>
            <div className="font-mono text-xs">{payment.customer.code}</div>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Applied to
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Invoice #</th>
              <th className="py-2 pr-3 text-right font-semibold">
                Invoice total
              </th>
              <th className="py-2 pr-3 text-right font-semibold">
                Amount applied
              </th>
              <th className="py-2 text-right font-semibold">
                Remaining balance
              </th>
            </tr>
          </thead>
          <tbody>
            {payment.applications.length === 0 ? (
              <tr className="border-b border-border">
                <td
                  colSpan={4}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  Not applied to any invoice — recorded as unapplied credit.
                </td>
              </tr>
            ) : (
              payment.applications.map((a) => {
                const remaining = a.invoice.total
                  .minus(a.invoice.amountPaid)
                  .minus(a.invoice.amountCredited);
                return (
                  <tr key={a.id} className="border-b border-border align-top">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {a.invoice.number}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatCurrency(a.invoice.total)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">
                      {formatCurrency(a.amount)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(remaining)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {payment.notes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{payment.notes}</p>
        </section>
      ) : null}

      {payment.reversedAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">REVERSED</div>
          {payment.reversedReason ? (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {payment.reversedReason}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="mt-10 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          Thank you for your payment.
        </section>
      )}
    </DocumentShell>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
