import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatCurrency } from '@/lib/format';
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

export default async function CreditMemoDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const cm = await db.creditMemo.findFirst({
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
      category: { select: { label: true } },
      invoice: { select: { id: true, number: true } },
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
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!cm) notFound();

  const company = await getCompanyInfo(db);
  const billing = cm.customer.addresses[0] ?? null;

  const totalsRows: TotalsRow[] = [
    { label: 'Gross amount', value: cm.amount.toString() },
  ];
  if (cm.restockingFee.greaterThan(0)) {
    totalsRows.push({
      label: 'Restocking fee',
      value: `-${formatCurrency(cm.restockingFee)}`,
      tone: 'muted',
    });
  }
  totalsRows.push({
    label: 'Net credit',
    value: cm.netCredit.toString(),
    tone: 'emphasis',
  });

  return (
    <DocumentShell
      backHref={`/credit-memos/${cm.id}`}
      backLabel={`CM ${cm.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Credit Memo"
        metadata={[
          { label: 'CM #', value: cm.number },
          { label: 'Date', value: formatDate(cm.issuedAt ?? cm.createdAt) },
          { label: 'Category', value: cm.category.label },
          ...(cm.invoice
            ? [{ label: 'Against invoice', value: cm.invoice.number }]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Credit to"
          address={
            billing
              ? {
                  name: cm.customer.name,
                  attention: billing.attention,
                  line1: billing.line1,
                  line2: billing.line2,
                  city: billing.city,
                  region: billing.region,
                  postalCode: billing.postalCode,
                  country: billing.country,
                  phone: cm.customer.primaryPhone,
                  email: cm.customer.primaryEmail,
                }
              : {
                  name: cm.customer.name,
                  phone: cm.customer.primaryPhone,
                  email: cm.customer.primaryEmail,
                }
          }
        />
        <div className="space-y-1 text-sm sm:text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Customer code
          </div>
          <div className="font-mono text-xs">{cm.customer.code}</div>
        </div>
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit price</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {cm.lines.length === 0 ? (
              <tr className="border-b border-border">
                <td
                  colSpan={6}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  No line items — this is an amount-only credit.
                </td>
              </tr>
            ) : (
              cm.lines.map((l) => (
                <tr key={l.id} className="border-b border-border align-top">
                  <LineThumbnailCell
                    url={resolveLineImageUrl(l.variant)}
                    alt={l.variant.product.name}
                  />
                  <td className="py-2 pr-3 font-mono text-xs">
                    {l.variant.sku}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{l.variant.product.name}</div>
                    {l.variant.name && l.variant.name !== l.variant.product.name ? (
                      <div className="text-xs text-muted-foreground">
                        {l.variant.name}
                      </div>
                    ) : null}
                    {l.description !== l.variant.product.name ? (
                      <div className="text-xs text-muted-foreground">
                        {l.description}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatQty(l.qty)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(l.unitPrice)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatCurrency(l.lineTotal)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {cm.reason ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reason
          </div>
          <p className="whitespace-pre-line text-sm">{cm.reason}</p>
        </section>
      ) : null}

      {cm.voidedAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">VOIDED</div>
          {cm.voidReason ? (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {cm.voidReason}
            </p>
          ) : null}
        </section>
      ) : null}
    </DocumentShell>
  );
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
