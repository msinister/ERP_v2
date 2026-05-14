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

export default async function PurchaseOrderDocumentPage({
  params,
}: {
  params: Promise<{ poId: string }>;
}) {
  const { poId } = await params;

  // Vendor-facing PO. Includes vendor's remit-to address + primary
  // contact for the "Vendor" block. Ship-to renders as our company
  // address (single-warehouse pilot — warehouse model has no address
  // fields per Q2 of the doc-templates discovery).
  const po = await db.purchaseOrder.findFirst({
    where: { id: poId, deletedAt: null },
    include: {
      vendor: {
        select: {
          id: true,
          code: true,
          name: true,
          defaultCurrency: true,
          paymentTerm: { select: { label: true, netDays: true } },
          addresses: {
            where: {
              kind: 'REMIT_TO',
              deletedAt: null,
              isDefault: true,
            },
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
              product: { select: { name: true } },
            },
          },
          warehouse: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!po) notFound();

  const company = getCompanyInfo();
  const remitTo = po.vendor.addresses[0] ?? null;
  const primaryContact = po.vendor.contacts[0] ?? null;

  // Σ qtyOrdered × unitCost across non-deleted lines. PO has no
  // header-level freight / tax — those live on the bill side.
  const subtotal = po.lines.reduce(
    (acc, l) => acc.plus(l.qtyOrdered.times(l.unitCost)),
    new Prisma.Decimal(0),
  );

  // Warehouses on each line may differ for a multi-warehouse PO. Show
  // the set as a comma-separated list in the Ship-to summary so the
  // vendor knows where to send what.
  const warehouseCodes = Array.from(
    new Set(po.lines.map((l) => l.warehouse.code)),
  );

  const totalsRows: TotalsRow[] = [
    { label: 'PO total', value: subtotal.toString(), tone: 'emphasis' },
  ];

  return (
    <DocumentShell
      backHref={`/purchase-orders/${po.id}`}
      backLabel={`PO ${po.number}`}
    >
      <DocumentHeader
        company={company}
        title="Purchase Order"
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
        ]}
      />

      <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <AddressBlock
          label="Vendor"
          address={
            remitTo
              ? {
                  name: po.vendor.name,
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
                  name: po.vendor.name,
                  attention: primaryContact?.name ?? null,
                  phone: primaryContact?.phone ?? null,
                  email: primaryContact?.email ?? null,
                }
          }
        />
        <AddressBlock
          label="Ship to"
          address={{
            name: company.name,
            line1: company.addressLine1,
            line2: company.addressLine2,
            city: company.city,
            region: company.region,
            postalCode: company.postalCode,
            country: company.country,
            phone: company.phone,
            email: company.email,
          }}
        />
      </section>

      <section className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-y border-border py-3 text-xs sm:grid-cols-4">
        <MetaPair label="Vendor code" value={po.vendor.code} />
        <MetaPair
          label="Payment terms"
          value={
            po.vendor.paymentTerm
              ? po.vendor.paymentTerm.netDays === null
                ? `${po.vendor.paymentTerm.label} (COD)`
                : `${po.vendor.paymentTerm.label} (net ${po.vendor.paymentTerm.netDays})`
              : '—'
          }
        />
        <MetaPair
          label="Currency"
          value={po.currency ?? po.vendor.defaultCurrency ?? 'USD'}
        />
        <MetaPair
          label="Warehouse"
          value={warehouseCodes.join(', ') || '—'}
        />
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">SKU</th>
              <th className="py-2 pr-3 font-semibold">Vendor SKU</th>
              <th className="py-2 pr-3 font-semibold">MPN</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit cost</th>
              <th className="py-2 text-right font-semibold">Line total</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-mono text-xs">{l.variant.sku}</td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                  {l.vendorSku ?? '—'}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                  {l.manufacturerPartNumber ?? '—'}
                </td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{l.variant.product.name}</div>
                  {l.variant.name ? (
                    <div className="text-xs text-muted-foreground">
                      {l.variant.name}
                    </div>
                  ) : null}
                  {/* Warehouse code only when the PO spans multiple
                      warehouses — single-warehouse PO already shows it
                      in the meta row above and the per-line repetition
                      is noise. */}
                  {warehouseCodes.length > 1 ? (
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Warehouse: {l.warehouse.code}
                    </div>
                  ) : null}
                  {l.notes ? (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      “{l.notes}”
                    </div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatQty(l.qtyOrdered)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCurrency(l.unitCost)}
                </td>
                <td className="py-2 text-right tabular-nums font-medium">
                  {formatCurrency(l.qtyOrdered.times(l.unitCost))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6">
        <TotalsFooter rows={totalsRows} />
      </section>

      {po.notes ? (
        <section className="mt-8 border-t border-border pt-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="whitespace-pre-line text-sm">{po.notes}</p>
        </section>
      ) : null}

      {po.cancelledAt ? (
        <section className="mt-8 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="font-semibold text-destructive">CANCELLED</div>
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
