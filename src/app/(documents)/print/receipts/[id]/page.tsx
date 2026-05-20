import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
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

export default async function ReceiptDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const receipt = await db.receipt.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: { select: { code: true, name: true } },
      warehouse: { select: { code: true, name: true } },
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
          warehouse: { select: { code: true } },
          purchaseOrderLine: {
            select: {
              purchaseOrder: { select: { number: true, deletedAt: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!receipt) notFound();

  const company = await getCompanyInfo(db);

  const poNumbers = Array.from(
    new Set(
      receipt.lines
        .map((l) => l.purchaseOrderLine?.purchaseOrder)
        .filter((po): po is { number: string; deletedAt: Date | null } =>
          Boolean(po && !po.deletedAt),
        )
        .map((po) => po.number),
    ),
  );

  const total = receipt.lines.reduce(
    (acc, l) => acc.plus(l.qtyReceived.times(l.unitCost)),
    new Prisma.Decimal(0),
  );

  const totalsRows: TotalsRow[] = [
    { label: 'Receipt total', value: total.toString(), tone: 'emphasis' },
  ];

  return (
    <DocumentShell
      backHref={`/receipts/${receipt.id}`}
      backLabel={`Receipt ${receipt.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Receipt"
        metadata={[
          { label: 'Receipt #', value: receipt.number },
          {
            label: 'Date',
            value: formatDate(receipt.receivedAt ?? receipt.createdAt),
          },
          { label: 'Status', value: formatStatusLabel(receipt.status) },
          { label: 'Warehouse', value: receipt.warehouse.code },
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Vendor"
          address={{ name: `${receipt.vendor.name} (${receipt.vendor.code})` }}
        />
        <div className="space-y-1 sm:text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            PO reference(s)
          </div>
          <div className="font-mono text-sm">
            {poNumbers.length > 0 ? poNumbers.join(', ') : '—'}
          </div>
        </div>
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 font-semibold">Warehouse</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty received</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit cost</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <LineThumbnailCell
                  url={resolveLineImageUrl(l.variant)}
                  alt={l.variant.product.name}
                />
                <td className="py-2 pr-3 font-mono text-xs">{l.variant.sku}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.variant.product.name}</div>
                  {l.variant.name && l.variant.name !== l.variant.product.name ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                  {l.warehouse.code}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {formatQty(l.qtyReceived)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCurrency(l.unitCost)}
                </td>
                <td className="py-2 text-right tabular-nums font-medium">
                  {formatCurrency(l.qtyReceived.times(l.unitCost))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {receipt.notes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{receipt.notes}</p>
        </section>
      ) : null}
    </DocumentShell>
  );
}

function formatQty(qty: Prisma.Decimal): string {
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
