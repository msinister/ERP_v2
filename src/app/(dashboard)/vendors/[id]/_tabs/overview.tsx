import { db } from '@/lib/db';
import type { Vendor } from '@/generated/tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getPaymentTerm } from '@/server/services/paymentTerms';
import { apBalanceForVendor, agingForVendor } from '@/server/services/ap';
import { listVendorAddresses } from '@/server/services/vendorAddresses';
import { formatCurrency } from '@/lib/format';
import { TabShell } from './tab-shell';

// Read-only summary of the most important vendor master fields plus a
// quick AP snapshot. Deeper AP detail lives in the AP tab.

export async function OverviewTab({ vendor }: { vendor: Vendor }) {
  const [paymentTerm, balance, aging, remitToAddresses] = await Promise.all([
    vendor.paymentTermId
      ? getPaymentTerm(db, vendor.paymentTermId)
      : Promise.resolve(null),
    apBalanceForVendor(db, vendor.id),
    agingForVendor(db, vendor.id),
    listVendorAddresses(db, vendor.id, { kind: 'REMIT_TO' }),
  ]);

  const defaultRemit =
    remitToAddresses.find((a) => a.isDefault) ?? remitToAddresses[0] ?? null;

  return (
    <TabShell>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Master</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="Type" value={formatVendorType(vendor.type)} />
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
                label="Default currency"
                value={vendor.defaultCurrency ?? 'USD'}
              />
              <Field
                label="Minimum order (warning)"
                value={
                  vendor.minimumOrderAmount == null
                    ? '—'
                    : formatCurrency(vendor.minimumOrderAmount)
                }
              />
              <Field
                label="Cost-change alert"
                value={
                  vendor.costChangeAlertPct == null
                    ? 'Global default'
                    : `${vendor.costChangeAlertPct.toString()}%`
                }
                fullWidth
              />
            </dl>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">AP snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field
                label="Open AP balance"
                value={formatCurrency(balance.apBalance)}
              />
              <Field
                label="Unapplied vendor credit"
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

      {defaultRemit ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Default remit-to</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {defaultRemit.attention ? (
              <div className="text-muted-foreground">
                Attn: {defaultRemit.attention}
              </div>
            ) : null}
            <div>{defaultRemit.line1}</div>
            {defaultRemit.line2 ? <div>{defaultRemit.line2}</div> : null}
            <div>
              {defaultRemit.city}, {defaultRemit.region} {defaultRemit.postalCode}
            </div>
            <div className="text-muted-foreground">{defaultRemit.country}</div>
          </CardContent>
        </Card>
      ) : null}

      {vendor.notes ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Internal notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {vendor.notes}
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

function formatVendorType(value: string): string {
  if (value === 'STOCK') return 'Stock';
  if (value === 'DROP_SHIP') return 'Drop-ship';
  if (value === 'SERVICE') return 'Service';
  return value;
}
