import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatCurrency, formatStatusLabel } from '@/lib/format';
import { DocumentShell } from '../../_components/document-shell';
import { DocumentHeader } from '../../_components/document-header';
import { AddressBlock } from '../../_components/address-block';
import { TotalsFooter, type TotalsRow } from '../../_components/totals-footer';

export const revalidate = 0;

export default async function SalesOrderDocumentPage({
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
          paymentTerm: { select: { label: true, netDays: true } },
          salesRep: { select: { name: true } },
          addresses: {
            where: { kind: 'BILLING', deletedAt: null, isDefault: true },
            take: 1,
          },
        },
      },
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
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!so) notFound();

  const company = getCompanyInfo();
  const billing = so.customer.addresses[0] ?? null;

  // Subtotal: Σ (qty × unitPrice − line discount). Order-level discount
  // applies to subtotal afterwards. Same math as
  // computeSalesOrderTotal in lib/ar/openSos.ts.
  let subtotal = new Prisma.Decimal(0);
  let lineDiscountTotal = new Prisma.Decimal(0);
  for (const l of so.lines) {
    const gross = l.qtyOrdered.times(l.unitPrice);
    let discount = new Prisma.Decimal(0);
    if (l.discountAmount != null) discount = l.discountAmount;
    else if (l.discountPercent != null)
      discount = gross.times(l.discountPercent).dividedBy(100);
    lineDiscountTotal = lineDiscountTotal.plus(discount);
    subtotal = subtotal.plus(gross.minus(discount));
  }
  const orderDiscount =
    so.orderDiscountAmount ??
    (so.orderDiscountPercent != null
      ? subtotal.times(so.orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));
  const shipping = so.shippingAmount ?? new Prisma.Decimal(0);
  const handling = so.handlingAmount ?? new Prisma.Decimal(0);
  const grandTotal = subtotal.minus(orderDiscount).plus(shipping).plus(handling);

  const totalsRows: TotalsRow[] = [
    { label: 'Subtotal', value: subtotal.toString() },
  ];
  if (lineDiscountTotal.greaterThan(0)) {
    totalsRows.push({
      label: 'Line discounts',
      value: `-${formatCurrency(lineDiscountTotal)}`,
      tone: 'muted',
    });
  }
  if (orderDiscount.greaterThan(0)) {
    totalsRows.push({
      label: 'Order discount',
      value: `-${formatCurrency(orderDiscount)}`,
      tone: 'muted',
    });
  }
  if (shipping.greaterThan(0)) {
    totalsRows.push({
      label: 'Shipping',
      value: shipping.toString(),
      tone: 'muted',
    });
  }
  if (handling.greaterThan(0)) {
    totalsRows.push({
      label: 'Handling',
      value: handling.toString(),
      tone: 'muted',
    });
  }
  totalsRows.push({
    label: 'Order total',
    value: grandTotal.toString(),
    tone: 'emphasis',
  });

  return (
    <DocumentShell
      backHref={`/sales-orders/${so.id}`}
      backLabel={`SO ${so.number}`}
    >
      <DocumentHeader
        company={company}
        title="Sales Order"
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
          label="Bill to"
          address={
            billing
              ? {
                  name: so.customer.name,
                  attention: billing.attention,
                  line1: billing.line1,
                  line2: billing.line2,
                  city: billing.city,
                  region: billing.region,
                  postalCode: billing.postalCode,
                  country: billing.country,
                  phone: so.customer.primaryPhone,
                  email: so.customer.primaryEmail,
                }
              : {
                  name: so.customer.name,
                  phone: so.customer.primaryPhone,
                  email: so.customer.primaryEmail,
                }
          }
        />
        <AddressBlock
          label="Ship to"
          freeText={so.shippingAddress}
          address={{ name: so.customer.name }}
        />
      </section>

      <section className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-y border-border py-3 text-xs sm:grid-cols-4">
        <MetaPair label="Sales rep" value={so.customer.salesRep?.name ?? '—'} />
        <MetaPair
          label="Payment terms"
          value={
            so.customer.paymentTerm
              ? so.customer.paymentTerm.netDays === null
                ? `${so.customer.paymentTerm.label} (COD)`
                : `${so.customer.paymentTerm.label} (net ${so.customer.paymentTerm.netDays})`
              : '—'
          }
        />
        <MetaPair label="Ship from" value={so.warehouse.name} />
        <MetaPair label="Currency" value={so.currency ?? 'USD'} />
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit price</th>
              <th className="py-2 pr-3 text-right font-semibold">Discount</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {so.lines.map((l) => {
              const gross = l.qtyOrdered.times(l.unitPrice);
              let discount = new Prisma.Decimal(0);
              if (l.discountAmount != null) discount = l.discountAmount;
              else if (l.discountPercent != null)
                discount = gross.times(l.discountPercent).dividedBy(100);
              const lineTotal = gross.minus(discount);
              return (
                <tr key={l.id} className="border-b border-border align-top">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {l.variant.sku}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{l.variant.product.name}</div>
                    {l.variant.name ? (
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
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatQty(l.qtyOrdered)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(l.unitPrice)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatLineDiscount(l)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">
                    {formatCurrency(lineTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {so.customerNotes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{so.customerNotes}</p>
        </section>
      ) : null}

      {so.cancelledAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">CANCELLED</div>
          {so.cancelReason ? (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {so.cancelReason}
            </p>
          ) : null}
        </section>
      ) : null}
    </DocumentShell>
  );
}

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function formatLineDiscount(l: {
  qtyOrdered: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
}): string {
  if (l.discountAmount != null) return `-${formatCurrency(l.discountAmount)}`;
  if (l.discountPercent != null) {
    return `-${l.discountPercent.toString()}%`;
  }
  return '—';
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
