import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatStatusLabel } from '@/lib/format';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { DocumentShell } from '../../../../_components/document-shell';
import { DocumentHeader } from '../../../../_components/document-header';
import { AddressBlock } from '../../../../_components/address-block';
import {
  LineThumbnailCell,
  LineThumbnailHead,
} from '../../../../_components/line-thumbnail';

export const revalidate = 0;

// PO-based check-in sheet. Printed BEFORE receiving so warehouse staff
// can hand-count against what the PO EXPECTS (ordered qty), then someone
// keys the figures in afterwards. The receipt-based sheet
// (/print/receipts/[id]/check-in) is the post-hoc counterpart — it shows
// what a drafted receipt actually expects. NO prices: internal document.

export default async function PoCheckInSheetDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const po = await db.purchaseOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      vendor: { select: { code: true, name: true } },
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
          warehouse: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!po) notFound();

  const company = await getCompanyInfo(db);

  // Per-line warehouse may differ on a multi-warehouse PO; show the set
  // so staff know where each delivery lands.
  const warehouseCodes = Array.from(
    new Set(po.lines.map((l) => l.warehouse.code)),
  );

  return (
    <DocumentShell
      backHref={`/purchase-orders/${po.id}`}
      backLabel={`PO ${po.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Check-In Sheet"
        metadata={[
          { label: 'PO #', value: po.number },
          { label: 'Date', value: formatDate(po.createdAt) },
          { label: 'Status', value: formatStatusLabel(po.status) },
          ...(po.expectedReceiveDate
            ? [
                {
                  label: 'Expected receive',
                  value: formatDate(po.expectedReceiveDate),
                },
              ]
            : []),
          ...(warehouseCodes.length > 0
            ? [{ label: 'Warehouse', value: warehouseCodes.join(', ') }]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Vendor"
          address={{ name: `${po.vendor.name} (${po.vendor.code})` }}
        />
        <div className="space-y-1 sm:text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Instructions
          </div>
          <div className="text-xs text-muted-foreground">
            Hand-count each line, write the received quantity, and flag
            condition. Return to the office for entry.
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
              <th className="py-2 pr-3 text-right font-semibold">Ordered</th>
              <th className="py-2 pr-3 text-right font-semibold">Received</th>
              <th className="py-2 pr-3 font-semibold">Condition</th>
              <th className="py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <LineThumbnailCell
                  url={resolveLineImageUrl(l.variant)}
                  alt={l.variant.product.name}
                />
                <td className="py-5 pr-3 font-mono text-xs">{l.variant.sku}</td>
                <td className="py-5 pr-3">
                  <div className="font-medium">{l.variant.product.name}</div>
                  {l.variant.name && l.variant.name !== l.variant.product.name ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name}
                    </div>
                  ) : null}
                  {/* Per-line warehouse only when the PO spans several —
                      otherwise it's already in the header meta. */}
                  {warehouseCodes.length > 1 ? (
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Warehouse: {l.warehouse.code}
                    </div>
                  ) : null}
                </td>
                <td className="py-5 pr-3 text-right tabular-nums">
                  {formatQty(l.qtyOrdered)}
                </td>
                {/* Blank cell for handwriting the physical count. */}
                <td className="py-5 pr-3 text-right">
                  <span className="inline-block min-w-[60px] border-b border-foreground/40">
                    &nbsp;
                  </span>
                </td>
                <td className="py-5 pr-3">
                  <div className="flex flex-col gap-1.5 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-3.5 border border-foreground/50" />
                      Good
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-3.5 border border-foreground/50" />
                      Damaged
                    </span>
                  </div>
                </td>
                <td className="py-5">
                  <span className="block min-h-[1.25rem] border-b border-foreground/30">
                    &nbsp;
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2">
        <SignatureLine label="Received by" />
        <SignatureLine label="Date received" />
      </section>
    </DocumentShell>
  );
}

function SignatureLine({ label }: { label: string }) {
  return (
    <div>
      <div className="h-8 border-b border-foreground/50" />
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
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
