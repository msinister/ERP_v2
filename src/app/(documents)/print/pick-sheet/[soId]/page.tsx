import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatStatusLabel } from '@/lib/format';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';
import {
  LineThumbnailCell,
  LineThumbnailHead,
} from '../../../_components/line-thumbnail';

export const revalidate = 0;

// Internal pick sheet. No prices. Per-line stock context (On hand /
// Available) from InventoryItem at the SO's warehouse. Customer's
// sticky internalNotes print in the header so the picker sees them
// inline rather than digging into the customer record.

const BOX_ROWS = 6; // empty rows on the page-2 box dimensions table

export default async function PickSheetDocumentPage({
  params,
}: {
  params: Promise<{ soId: string }>;
}) {
  const { soId } = await params;

  const so = await db.salesOrder.findFirst({
    where: { id: soId, deletedAt: null },
    include: {
      customer: {
        select: {
          id: true,
          code: true,
          name: true,
          internalNotes: true,
          primaryPhone: true,
          primaryEmail: true,
        },
      },
      warehouse: { select: { id: true, code: true, name: true } },
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              id: true,
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
  if (!so) notFound();

  // Batched stock lookup: every variant on the SO at the SO's
  // warehouse. Available = onHand − reserved (same formula used by
  // the reservation service).
  const variantIds = so.lines.map((l) => l.variant.id);
  const stockRows =
    variantIds.length > 0
      ? await db.inventoryItem.findMany({
          where: {
            warehouseId: so.warehouseId,
            variantId: { in: variantIds },
          },
          select: {
            variantId: true,
            onHand: true,
            reserved: true,
          },
        })
      : [];
  const stockByVariant = new Map(stockRows.map((s) => [s.variantId, s]));

  const company = await getCompanyInfo(db);

  return (
    <DocumentShell
      backHref={`/sales-orders/${so.id}`}
      backLabel={`SO ${so.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Pick Sheet"
        metadata={[
          { label: 'SO #', value: so.number },
          { label: 'Date', value: formatDate(so.orderDate) },
          { label: 'Status', value: formatStatusLabel(so.status) },
          ...(so.customerPo
            ? [{ label: 'Customer PO', value: so.customerPo }]
            : []),
          ...(so.promisedShipDate
            ? [
                {
                  label: 'Promised ship',
                  value: formatDate(so.promisedShipDate),
                },
              ]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Customer"
          address={{
            name: `${so.customer.name} (${so.customer.code})`,
            phone: so.customer.primaryPhone,
            email: so.customer.primaryEmail,
          }}
        />
        <AddressBlock
          label="Ship to"
          freeText={so.shippingAddress}
          address={{ name: so.customer.name }}
        />
      </section>

      {so.customer.internalNotes ? (
        <section className="mt-6 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
            Customer notes (sticky)
          </div>
          <p className="whitespace-pre-line text-sm">
            {so.customer.internalNotes}
          </p>
        </section>
      ) : null}

      {so.internalNotes ? (
        <section className="mt-3 rounded border border-border bg-muted/30 p-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
            Order notes (internal)
          </div>
          <p className="whitespace-pre-line text-sm">{so.internalNotes}</p>
        </section>
      ) : null}

      <section className="mt-6">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          Warehouse: {so.warehouse.name} ({so.warehouse.code})
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty ordered</th>
              <th className="py-2 pr-3 text-right font-semibold">On hand</th>
              <th className="py-2 pr-3 text-right font-semibold">Available</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty picked</th>
              <th className="py-2 font-semibold">Packed by</th>
            </tr>
          </thead>
          <tbody>
            {so.lines.map((l) => {
              const stock = stockByVariant.get(l.variant.id);
              const onHand = stock?.onHand ?? new Prisma.Decimal(0);
              const reserved = stock?.reserved ?? new Prisma.Decimal(0);
              const available = onHand.minus(reserved);
              const insufficient = available.lessThan(l.qtyOrdered);
              return (
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
                    {l.customerNote ? (
                      <div className="mt-1 text-xs italic text-muted-foreground">
                        “{l.customerNote}”
                      </div>
                    ) : null}
                    {l.internalNote ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Internal: {l.internalNote}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">
                    {formatQty(l.qtyOrdered)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {formatQty(onHand)}
                  </td>
                  <td
                    className={
                      'py-2 pr-3 text-right tabular-nums ' +
                      (insufficient
                        ? 'font-semibold text-destructive'
                        : 'text-muted-foreground')
                    }
                  >
                    {formatQty(available)}
                  </td>
                  {/* Empty cells with grid-style borders for hand-entry. */}
                  <td className="py-2 pr-3 text-right">
                    <span className="inline-block min-w-[60px] border-b border-foreground/40">
                      &nbsp;
                    </span>
                  </td>
                  <td className="py-2">
                    <span className="inline-block min-w-[80px] border-b border-foreground/40">
                      &nbsp;
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Page 2 — box dimensions log. page-break-before makes this its
          own page on print so picking + packing data don't fight for
          space. */}
      <section
        className="mt-10 break-before-page pt-6"
        style={{ pageBreakBefore: 'always' }}
      >
        <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          Box dimensions
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold w-12">Box #</th>
              <th className="py-2 pr-3 font-semibold">Length</th>
              <th className="py-2 pr-3 font-semibold">Width</th>
              <th className="py-2 pr-3 font-semibold">Height</th>
              <th className="py-2 pr-3 font-semibold">Weight</th>
              <th className="py-2 font-semibold">Tracking #</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: BOX_ROWS }).map((_, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-3 pr-3 text-center font-mono text-xs text-muted-foreground">
                  {i + 1}
                </td>
                <td className="py-3 pr-3">&nbsp;</td>
                <td className="py-3 pr-3">&nbsp;</td>
                <td className="py-3 pr-3">&nbsp;</td>
                <td className="py-3 pr-3">&nbsp;</td>
                <td className="py-3">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
