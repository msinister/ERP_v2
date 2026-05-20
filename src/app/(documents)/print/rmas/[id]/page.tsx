import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCompanyInfo, type CompanyInfo } from '@/lib/company-info';
import { formatCurrency } from '@/lib/format';
import { resolveLineImageUrl } from '@/lib/products/lineItemImage';
import {
  getRestockingFeeDefault,
  resolveRestockingFee,
} from '@/server/services/restockingFee';
import { DocumentShell } from '../../../_components/document-shell';
import { DocumentHeader } from '../../../_components/document-header';
import { AddressBlock } from '../../../_components/address-block';
import { TotalsFooter, type TotalsRow } from '../../../_components/totals-footer';
import {
  LineThumbnailCell,
  LineThumbnailHead,
} from '../../../_components/line-thumbnail';

export const revalidate = 0;

export default async function RmaDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [rma, restockingDefault] = await Promise.all([
    db.rma.findFirst({
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
              where: { kind: 'SHIPPING', deletedAt: null, isDefault: true },
              take: 1,
            },
          },
        },
        invoice: { select: { number: true } },
        lines: {
          where: { deletedAt: null },
          include: {
            invoiceLine: {
              select: {
                description: true,
                unitPrice: true,
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
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    getRestockingFeeDefault(db),
  ]);
  if (!rma) notFound();

  const company = await getCompanyInfo(db);
  const shipping = rma.customer.addresses[0] ?? null;

  const zero = new Prisma.Decimal(0);
  let grossTotal = zero;
  const lines = rma.lines.map((l) => {
    const lineTotal = l.qty.times(l.invoiceLine.unitPrice);
    grossTotal = grossTotal.plus(lineTotal);
    return {
      id: l.id,
      sku: l.invoiceLine.variant.sku,
      productName: l.invoiceLine.variant.product.name,
      variantName: l.invoiceLine.variant.name,
      imageUrl: resolveLineImageUrl(l.invoiceLine.variant),
      description: l.invoiceLine.description,
      qty: l.qty,
      unitPrice: l.invoiceLine.unitPrice,
      lineTotal,
    };
  });

  const effective = resolveRestockingFee(
    {
      percent: rma.restockingFeePercent ?? null,
      flat: rma.restockingFeeFlat ?? null,
    },
    restockingDefault,
  );
  let restockingFeeAmount = zero;
  if (effective.flat != null) {
    restockingFeeAmount = effective.flat;
  } else if (effective.percent != null) {
    restockingFeeAmount = grossTotal.times(effective.percent).dividedBy(100);
  }
  if (restockingFeeAmount.greaterThan(grossTotal)) {
    restockingFeeAmount = grossTotal;
  }
  const hasRestockingFee = restockingFeeAmount.greaterThan(0);
  const netCredit = grossTotal.minus(restockingFeeAmount);

  const totalsRows: TotalsRow[] = [
    { label: 'Gross amount', value: grossTotal.toString() },
  ];
  if (hasRestockingFee) {
    totalsRows.push({
      label: restockingFeeNoticeLabel(effective),
      value: `-${formatCurrency(restockingFeeAmount)}`,
      tone: 'muted',
    });
    totalsRows.push({
      label: 'Estimated credit',
      value: netCredit.toString(),
      tone: 'emphasis',
    });
  }

  return (
    <DocumentShell
      backHref={`/rmas/${rma.id}`}
      backLabel={`RMA ${rma.number}`}
      thumbnailToggle
    >
      <DocumentHeader
        company={company}
        title="Return Merchandise Authorization"
        metadata={[
          { label: 'RMA #', value: rma.number },
          { label: 'Date', value: formatDate(rma.createdAt) },
          { label: 'Type', value: rma.returnless ? 'Returnless' : 'Standard' },
          { label: 'Against invoice', value: rma.invoice.number },
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Customer"
          address={
            shipping
              ? {
                  name: rma.customer.name,
                  attention: shipping.attention,
                  line1: shipping.line1,
                  line2: shipping.line2,
                  city: shipping.city,
                  region: shipping.region,
                  postalCode: shipping.postalCode,
                  country: shipping.country,
                  phone: rma.customer.primaryPhone,
                  email: rma.customer.primaryEmail,
                }
              : {
                  name: rma.customer.name,
                  phone: rma.customer.primaryPhone,
                  email: rma.customer.primaryEmail,
                }
          }
        />
        <AddressBlock label="Return to" address={companyAsAddress(company)} />
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <LineThumbnailHead />
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">
                Qty authorized
              </th>
              <th className="py-2 pr-3 text-right font-semibold">Unit price</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <LineThumbnailCell url={l.imageUrl} alt={l.productName} />
                <td className="py-2 pr-3 font-mono text-xs">{l.sku}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.productName}</div>
                  {l.variantName && l.variantName !== l.productName ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variantName}
                    </div>
                  ) : null}
                  {l.description !== l.productName ? (
                    <div className="text-xs text-muted-foreground">
                      {l.description}
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {formatQty(l.qty)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCurrency(l.unitPrice)}
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

      {hasRestockingFee ? (
        <section className="mt-6 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <div className="font-semibold">Restocking fee notice</div>
          <p className="mt-1 text-muted-foreground">
            A restocking fee of {restockingFeeDescription(effective)} applies to
            this return. The estimated credit above reflects this deduction.
          </p>
        </section>
      ) : null}

      {rma.reason ? (
        <section className="mt-6 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reason
          </div>
          <p className="whitespace-pre-line text-sm">{rma.reason}</p>
        </section>
      ) : null}

      <section className="mt-8 rounded border border-border bg-muted/30 p-4 text-sm">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Return instructions
        </div>
        <p className="text-sm">
          Please include this RMA document in your return shipment.
        </p>
        <p className="mt-2 text-sm">
          <span className="font-medium">Ship to:</span> {companyAddressLine(company)}
        </p>
      </section>
    </DocumentShell>
  );
}

function companyAsAddress(company: CompanyInfo) {
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

// Single-line company address for the inline "Ship to:" sentence.
function companyAddressLine(company: CompanyInfo): string {
  const cityRegionPostal = [company.city, company.region, company.postalCode]
    .filter(Boolean)
    .join(company.city && company.region ? ', ' : ' ')
    .trim();
  return [
    company.name,
    company.addressLine1,
    company.addressLine2,
    cityRegionPostal,
    company.country,
  ]
    .filter(Boolean)
    .join(', ');
}

function restockingFeeNoticeLabel(fee: {
  percent: Prisma.Decimal | null;
  flat: Prisma.Decimal | null;
}): string {
  if (fee.flat != null) return 'Restocking fee';
  if (fee.percent != null)
    return `Restocking fee (${stripZeros(fee.percent)}%)`;
  return 'Restocking fee';
}

function restockingFeeDescription(fee: {
  percent: Prisma.Decimal | null;
  flat: Prisma.Decimal | null;
}): string {
  if (fee.flat != null) return formatCurrency(fee.flat);
  if (fee.percent != null) return `${stripZeros(fee.percent)}%`;
  return '—';
}

function stripZeros(d: Prisma.Decimal): string {
  const s = d.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
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
