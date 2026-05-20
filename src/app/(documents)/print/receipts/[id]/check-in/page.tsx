import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatStatusLabel } from '@/lib/format';
import { DocumentShell } from '../../../../_components/document-shell';
import { DocumentHeader } from '../../../../_components/document-header';
import { AddressBlock } from '../../../../_components/address-block';

export const revalidate = 0;

// Internal warehouse check-in sheet. NO prices. Printed when a shipment
// arrives so staff can hand-count actual received quantities and flag
// condition against what the receipt expects. Expected Qty is the
// receipt line's drafted qty; Received Qty + condition are blank for
// handwriting.

export default async function CheckInSheetDocumentPage({
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
              product: { select: { name: true } },
            },
          },
          purchaseOrderLine: {
            select: {
              purchaseOrder: {
                select: { number: true, deletedAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!receipt) notFound();

  const company = getCompanyInfo();

  // Distinct PO numbers across the receipt's lines (a single shipment
  // can cover multiple POs).
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

  return (
    <DocumentShell
      backHref={`/receipts/${receipt.id}`}
      backLabel={`Receipt ${receipt.number}`}
    >
      <DocumentHeader
        company={company}
        title="Check-In Sheet"
        metadata={[
          { label: 'Receipt #', value: receipt.number },
          { label: 'Date', value: formatDate(receipt.createdAt) },
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
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Expected</th>
              <th className="py-2 pr-3 text-right font-semibold">Received</th>
              <th className="py-2 pr-3 font-semibold">Condition</th>
              <th className="py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <td className="py-5 pr-3 font-mono text-xs">{l.variant.sku}</td>
                <td className="py-5 pr-3">
                  <div className="font-medium">{l.variant.product.name}</div>
                  {l.variant.name ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name}
                    </div>
                  ) : null}
                </td>
                <td className="py-5 pr-3 text-right tabular-nums">
                  {formatQty(l.qtyReceived)}
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
