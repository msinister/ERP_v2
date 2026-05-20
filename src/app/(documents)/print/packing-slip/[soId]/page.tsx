import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';
import {
  LineThumbnailCell,
  LineThumbnailHead,
} from '../../../_components/line-thumbnail';

export const revalidate = 0;

// Packing slip — physical doc that ships in the box. NO PRICES (the
// customer's invoice is separate). Just lines + qty + ship-to + the
// customer-facing notes from the order.

export default async function PackingSlipDocumentPage({
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
          primaryEmail: true,
          primaryPhone: true,
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
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!so) notFound();

  const company = await getCompanyInfo(db);

  return (
    <DocumentShell
      backHref={`/sales-orders/${so.id}`}
      backLabel={`SO ${so.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Packing Slip"
        metadata={[
          { label: 'SO #', value: so.number },
          { label: 'Date', value: formatDate(so.orderDate) },
          ...(so.customerPo
            ? [{ label: 'Customer PO', value: so.customerPo }]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="From"
          address={{
            name: company.name,
            line1: company.addressLine1,
            line2: company.addressLine2,
            city: company.city,
            region: company.region,
            postalCode: company.postalCode,
            country: company.country,
          }}
        />
        <AddressBlock
          label="Ship to"
          freeText={so.shippingAddress}
          address={{
            name: so.customer.name,
            phone: so.customer.primaryPhone,
            email: so.customer.primaryEmail,
          }}
        />
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Qty</th>
            </tr>
          </thead>
          <tbody>
            {so.lines.map((l) => (
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
                  {l.customerNote ? (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      “{l.customerNote}”
                    </div>
                  ) : null}
                </td>
                <td className="py-2 text-right tabular-nums font-medium">
                  {formatQty(l.qtyOrdered)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {so.customerNotes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{so.customerNotes}</p>
        </section>
      ) : null}

      <section className="mt-12 text-center text-xs text-muted-foreground">
        Thank you for your business.
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
