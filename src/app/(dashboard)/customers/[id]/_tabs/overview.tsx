import { db } from '@/lib/db';
import type { Customer } from '@/generated/tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getSalesRep } from '@/server/services/salesReps';
import { getPaymentTerm } from '@/server/services/paymentTerms';
import { arBalanceForCustomer, agingForCustomer } from '@/server/services/ar';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { TabShell } from './tab-shell';

// Read-only summary of the most important customer master fields plus
// a quick AR snapshot. The deeper AR detail lives in the AR tab.

export async function OverviewTab({ customer }: { customer: Customer }) {
  const [salesRep, paymentTerm, balance, aging] = await Promise.all([
    getSalesRep(db, customer.salesRepId),
    getPaymentTerm(db, customer.paymentTermId),
    arBalanceForCustomer(db, customer.id),
    agingForCustomer(db, customer.id),
  ]);

  return (
    <TabShell>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Master</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field
                label="Type"
                value={formatCustomerType(customer.type)}
              />
              <Field
                label="Sales rep"
                value={salesRep?.name ?? '—'}
              />
              <Field
                label="Payment term"
                value={
                  paymentTerm
                    ? `${paymentTerm.label} (${
                        paymentTerm.netDays === null
                          ? 'COD'
                          : `net ${paymentTerm.netDays}`
                      })`
                    : '—'
                }
              />
              <Field
                label="Tax exempt"
                value={customer.taxExempt ? 'Yes' : 'No'}
              />
              <Field
                label="Resale cert"
                value={customer.resaleCertNumber ?? '—'}
              />
              <Field
                label="Phone"
                value={customer.primaryPhone ?? '—'}
              />
              <Field
                label="Email"
                value={customer.primaryEmail ?? '—'}
                fullWidth
              />
            </dl>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Credit & AR</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field
                label="Credit limit"
                value={
                  customer.creditLimit == null
                    ? 'No limit'
                    : formatCurrency(customer.creditLimit)
                }
              />
              <Field
                label="AR hold (days past due)"
                value={
                  customer.arHoldDays == null
                    ? 'Off'
                    : `${customer.arHoldDays} d`
                }
              />
              <Field
                label="Open AR balance"
                value={formatCurrency(balance.arBalance)}
              />
              <Field
                label="Unapplied credit"
                value={formatCurrency(balance.unappliedCreditBalance)}
              />
              <Field
                label="91+ overdue"
                value={formatCurrency(aging.buckets.b91plus)}
                fullWidth
                emphasis={
                  aging.buckets.b91plus.gt(0) ? 'destructive' : undefined
                }
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {customer.internalNotes ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Internal notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {customer.internalNotes}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </TabShell>
  );
}

function Field({
  label,
  value,
  fullWidth,
  emphasis,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
  emphasis?: 'destructive';
}) {
  return (
    <div className={fullWidth ? 'col-span-2' : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis === 'destructive'
            ? 'font-medium text-destructive'
            : 'font-medium text-foreground'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function formatCustomerType(value: string): string {
  if (value === 'RETAIL') return 'Retail';
  if (value.startsWith('WHOLESALE_')) {
    const tail = value.slice('WHOLESALE_'.length);
    return `Wholesale — ${formatStatusLabel(tail).toLowerCase()}`;
  }
  return formatStatusLabel(value);
}
