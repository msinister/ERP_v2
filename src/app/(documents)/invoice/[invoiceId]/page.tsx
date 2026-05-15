import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo } from '@/lib/company-info';
import { formatCurrency } from '@/lib/format';
import { DocumentShell } from '../../_components/document-shell';
import { DocumentHeader } from '../../_components/document-header';
import { AddressBlock } from '../../_components/address-block';
import { TotalsFooter, type TotalsRow } from '../../_components/totals-footer';

export const revalidate = 0;

export default async function InvoiceDocumentPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;

  // Single round-trip: invoice + lines (with variant SKU + product
  // name) + customer (with default BILLING address + sales rep) +
  // warehouse + parent SO (for shipping address + customerPo +
  // promised ship date).
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
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
      salesOrder: {
        select: {
          number: true,
          customerPo: true,
          promisedShipDate: true,
          shippingAddress: true,
        },
      },
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
  if (!invoice) notFound();

  const company = getCompanyInfo();

  // Derive dueDate from the customer's paymentTerm.netDays applied to
  // the invoiceDate. COD/Prepay (netDays === null) shows the invoice
  // date itself — matches AR aging's convention.
  const dueDate = invoice.customer.paymentTerm
    ? invoice.customer.paymentTerm.netDays != null
      ? new Date(
          invoice.invoiceDate.getTime() +
            invoice.customer.paymentTerm.netDays * 86_400_000,
        )
      : invoice.invoiceDate
    : null;

  const billing = invoice.customer.addresses[0] ?? null;
  const balance = invoice.total
    .minus(invoice.amountPaid)
    .minus(invoice.amountCredited);

  // Sum line-level discounts so the footer can show them as a single
  // line. Order-level discount lives on the Invoice header.
  const lineDiscountTotal = invoice.lines.reduce((acc, l) => {
    const lineGross = l.qty.times(l.unitPrice);
    let discount = new Prisma.Decimal(0);
    if (l.discountAmount != null) discount = l.discountAmount;
    else if (l.discountPercent != null)
      discount = lineGross.times(l.discountPercent).dividedBy(100);
    return acc.plus(discount);
  }, new Prisma.Decimal(0));

  const totalsRows: TotalsRow[] = [
    { label: 'Subtotal', value: invoice.subtotal.toString() },
  ];
  if (lineDiscountTotal.greaterThan(0)) {
    totalsRows.push({
      label: 'Line discounts',
      value: `-${formatCurrency(lineDiscountTotal)}`,
      tone: 'muted',
    });
  }
  if (invoice.orderDiscount.greaterThan(0)) {
    totalsRows.push({
      label: 'Order discount',
      value: `-${formatCurrency(invoice.orderDiscount)}`,
      tone: 'muted',
    });
  }
  if (invoice.shippingAmount.greaterThan(0)) {
    totalsRows.push({
      label: 'Shipping',
      value: invoice.shippingAmount.toString(),
      tone: 'muted',
    });
  }
  if (invoice.handlingAmount.greaterThan(0)) {
    totalsRows.push({
      label: 'Handling',
      value: invoice.handlingAmount.toString(),
      tone: 'muted',
    });
  }
  totalsRows.push({
    label: 'Total',
    value: invoice.total.toString(),
    tone: 'emphasis',
  });
  if (invoice.amountPaid.greaterThan(0)) {
    totalsRows.push({
      label: 'Paid',
      value: `-${formatCurrency(invoice.amountPaid)}`,
      tone: 'muted',
    });
  }
  if (invoice.amountCredited.greaterThan(0)) {
    totalsRows.push({
      label: 'Credits applied',
      value: `-${formatCurrency(invoice.amountCredited)}`,
      tone: 'muted',
    });
  }
  totalsRows.push({
    label: 'Balance due',
    value: balance.toString(),
    tone: 'emphasis',
  });

  return (
    <DocumentShell
      // Detached invoices (SO reopened) fall back to the invoices list.
      backHref={
        invoice.salesOrder
          ? `/sales-orders/${invoice.salesOrderId}`
          : '/invoices'
      }
      backLabel={
        invoice.salesOrder ? `SO ${invoice.salesOrder.number}` : 'Invoices'
      }
    >
      <DocumentHeader
        company={company}
        title="Invoice"
        metadata={[
          { label: 'Invoice #', value: invoice.number },
          { label: 'Date', value: formatDate(invoice.invoiceDate) },
          ...(dueDate
            ? [{ label: 'Due', value: formatDate(dueDate) }]
            : []),
          // salesOrder is nullable post-reopen — invoice can survive
          // its SO being detached. Show the SO row only when still linked.
          ...(invoice.salesOrder
            ? [{ label: 'SO #', value: invoice.salesOrder.number }]
            : []),
          ...(invoice.salesOrder?.customerPo
            ? [{ label: 'Customer PO', value: invoice.salesOrder.customerPo }]
            : []),
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Bill to"
          address={
            billing
              ? {
                  name: invoice.customer.name,
                  attention: billing.attention,
                  line1: billing.line1,
                  line2: billing.line2,
                  city: billing.city,
                  region: billing.region,
                  postalCode: billing.postalCode,
                  country: billing.country,
                  phone: invoice.customer.primaryPhone,
                  email: invoice.customer.primaryEmail,
                }
              : {
                  name: invoice.customer.name,
                  phone: invoice.customer.primaryPhone,
                  email: invoice.customer.primaryEmail,
                }
          }
        />
        <AddressBlock
          label="Ship to"
          freeText={invoice.salesOrder?.shippingAddress ?? null}
          address={{ name: invoice.customer.name }}
        />
      </section>

      <section className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-y border-border py-3 text-xs sm:grid-cols-4">
        <MetaPair label="Sales rep" value={invoice.customer.salesRep?.name ?? '—'} />
        <MetaPair
          label="Payment terms"
          value={
            invoice.customer.paymentTerm
              ? invoice.customer.paymentTerm.netDays === null
                ? `${invoice.customer.paymentTerm.label} (COD)`
                : `${invoice.customer.paymentTerm.label} (net ${invoice.customer.paymentTerm.netDays})`
              : '—'
          }
        />
        <MetaPair label="Ship from" value={invoice.warehouse.name} />
        <MetaPair
          label="Promised ship"
          value={
            invoice.salesOrder?.promisedShipDate
              ? formatDate(invoice.salesOrder.promisedShipDate)
              : '—'
          }
        />
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
            {invoice.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-mono text-xs">{l.variant.sku}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.variant.product.name}</div>
                  {l.variant.name ? (
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
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatLineDiscount(l)}
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

      {invoice.customerNotes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{invoice.customerNotes}</p>
        </section>
      ) : null}

      {invoice.voidedAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">VOIDED</div>
          {invoice.voidReason ? (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">
              {invoice.voidReason}
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
  qty: Prisma.Decimal;
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
