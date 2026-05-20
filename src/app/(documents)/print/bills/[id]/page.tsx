import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';
import { TotalsFooter, type TotalsRow } from '../../../_components/totals-footer';
import {
  LineThumbnailCell,
  LineThumbnailHead,
} from '../../../_components/line-thumbnail';

export const revalidate = 0;

export default async function BillDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const bill = await db.bill.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: {
        select: {
          id: true,
          code: true,
          name: true,
          paymentTerm: { select: { label: true, netDays: true } },
          addresses: {
            where: { kind: 'REMIT_TO', deletedAt: null, isDefault: true },
            take: 1,
          },
          contacts: {
            where: { deletedAt: null, isPrimary: true },
            take: 1,
          },
        },
      },
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              sku: true,
              name: true,
              imageUrl: true,
              product: {
                select: {
                  name: true,
                  images: {
                    where: { isPrimary: true, deletedAt: null },
                    select: { url: true },
                    orderBy: { sortOrder: 'asc' },
                    take: 1,
                  },
                },
              },
            },
          },
          expenseAccount: { select: { code: true, name: true } },
        },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });
  if (!bill) notFound();

  const company = await getCompanyInfo(db);
  const remitTo = bill.vendor.addresses[0] ?? null;
  const primaryContact = bill.vendor.contacts[0] ?? null;
  const balance = bill.total
    .minus(bill.amountPaid)
    .minus(bill.amountCredited);

  const totalsRows: TotalsRow[] = [
    { label: 'Subtotal', value: bill.subtotal.toString() },
  ];
  if (bill.freight.greaterThan(0)) {
    totalsRows.push({
      label: 'Freight',
      value: bill.freight.toString(),
      tone: 'muted',
    });
  }
  if (bill.tax.greaterThan(0)) {
    totalsRows.push({ label: 'Tax', value: bill.tax.toString(), tone: 'muted' });
  }
  totalsRows.push({
    label: 'Bill total',
    value: bill.total.toString(),
    tone: 'emphasis',
  });
  if (bill.amountPaid.greaterThan(0)) {
    totalsRows.push({
      label: 'Amount paid',
      value: `-${formatCurrency(bill.amountPaid)}`,
      tone: 'muted',
    });
  }
  if (bill.amountCredited.greaterThan(0)) {
    totalsRows.push({
      label: 'Credits applied',
      value: `-${formatCurrency(bill.amountCredited)}`,
      tone: 'muted',
    });
  }
  totalsRows.push({
    label: 'Balance',
    value: balance.toString(),
    tone: 'emphasis',
  });

  return (
    <DocumentShell
      backHref={`/bills/${bill.id}`}
      backLabel={`Bill ${bill.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Bill"
        metadata={[
          { label: 'Bill #', value: bill.number },
          ...(bill.vendorReference
            ? [{ label: 'Vendor ref', value: bill.vendorReference }]
            : []),
          { label: 'Bill date', value: formatDate(bill.billDate) },
          ...(bill.dueDate
            ? [{ label: 'Due', value: formatDate(bill.dueDate) }]
            : []),
          { label: 'Status', value: formatStatusLabel(bill.status) },
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Vendor"
          address={
            remitTo
              ? {
                  name: bill.vendor.name,
                  attention: remitTo.attention ?? primaryContact?.name ?? null,
                  line1: remitTo.line1,
                  line2: remitTo.line2,
                  city: remitTo.city,
                  region: remitTo.region,
                  postalCode: remitTo.postalCode,
                  country: remitTo.country,
                  phone: remitTo.phone ?? primaryContact?.phone ?? null,
                  email: primaryContact?.email ?? null,
                }
              : {
                  name: bill.vendor.name,
                  attention: primaryContact?.name ?? null,
                  phone: primaryContact?.phone ?? null,
                  email: primaryContact?.email ?? null,
                }
          }
        />
        <AddressBlock label="Bill to" address={companyAsAddress(company)} />
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit cost</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <LineThumbnailCell
                  url={resolveLineImageUrl(l.variant)}
                  alt={l.variant?.product.name ?? l.description}
                />
                <td className="py-2 pr-3 font-mono text-xs">
                  {l.variant?.sku ?? '—'}
                </td>
                <td className="py-2 pr-3">
                  {l.variant ? (
                    <>
                      <div className="font-medium">
                        {l.variant.product.name}
                      </div>
                      {l.variant.name &&
                      l.variant.name !== l.variant.product.name ? (
                        <div className="text-xs text-muted-foreground">
                          {l.variant.name}
                        </div>
                      ) : null}
                      {l.description !== l.variant.product.name ? (
                        <div className="text-xs text-muted-foreground">
                          {l.description}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="font-medium">{l.description}</div>
                      {l.expenseAccount ? (
                        <div className="text-xs text-muted-foreground">
                          {l.expenseAccount.code} · {l.expenseAccount.name}
                        </div>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatQty(l.qty)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCurrency(l.unitCost)}
                </td>
                <td className="py-2 text-right tabular-nums font-medium">
                  {formatCurrency(l.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {bill.notes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{bill.notes}</p>
        </section>
      ) : null}

      {bill.cancelledAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">CANCELLED</div>
          {bill.cancelReason ? (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {bill.cancelReason}
            </p>
          ) : null}
        </section>
      ) : null}
    </DocumentShell>
  );
}

function companyAsAddress(company: Awaited<ReturnType<typeof getCompanyInfo>>) {
  return {
    name: company.name,
    line1: company.addressLine1,
    line2: company.addressLine2,
    city: company.city,
    region: company.region,
    postalCode: company.postalCode,
    country: company.country,
    phone: company.phone,
    email: company.email,
  };
}

function formatQty(qty: { toString(): string }): string {
  const s = qty.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
