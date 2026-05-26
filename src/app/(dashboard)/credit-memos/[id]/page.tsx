import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import {
  lineItemImageVariantSelect,
  resolveLineImageUrl,
} from '@/lib/products/lineItemImage';
import { getActor } from '@/lib/permissions/getActor';
import { creditMemoScopeWhere } from '@/lib/permissions/scope';
import { CreditMemoHeader } from './_components/header';
import {
  CreditMemoLinesTable,
  type CmLineRow,
} from './_components/lines-table';
import { CreditMemoTotalsCard } from './_components/totals-card';
import { CreditMemoInfoCard } from './_components/info-card';
import {
  ApplicationsCard,
  type CmApplicationRow,
} from './_components/applications-card';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OrderTagsEditor } from '@/components/shared/order-tags-editor';

export const revalidate = 0;

export default async function CreditMemoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');

  const cm = await db.creditMemo.findFirst({
    where: { AND: [{ id, deletedAt: null }, creditMemoScopeWhere(actor)] },
    include: {
      customer: { select: { id: true, code: true, name: true } },
      category: {
        select: {
          id: true,
          code: true,
          label: true,
          affectsInventory: true,
        },
      },
      invoice: { select: { id: true, number: true } },
      rma: { select: { id: true, number: true } },
      lines: {
        where: { deletedAt: null },
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
              inventory: {
                select: { onHand: true, reserved: true },
              },
              ...lineItemImageVariantSelect,
              product: {
                select: {
                  name: true,
                  // image already pulled via lineItemImageVariantSelect
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
          invoiceLine: {
            select: {
              id: true,
              invoice: { select: { id: true, number: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      applications: {
        include: { invoice: { select: { id: true, number: true } } },
        orderBy: { appliedAt: 'desc' },
      },
      tags: {
        include: { tag: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!cm) notFound();

  const hasApplications = cm.appliedAmount.greaterThan(0);

  const lineRows: CmLineRow[] = cm.lines.map((l) => {
    // Aggregate QOH across all warehouses (pilot is single-warehouse;
    // multi-warehouse arrives via the deferred slice). Strip trailing
    // zeros at render time.
    const totalOnHand = l.variant.inventory.reduce(
      (acc, inv) => acc + Number(inv.onHand.toString()),
      0,
    );
    const totalReserved = l.variant.inventory.reduce(
      (acc, inv) => acc + Number(inv.reserved.toString()),
      0,
    );
    return {
      id: l.id,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      variant: {
        id: l.variant.id,
        sku: l.variant.sku,
        name: l.variant.name,
        productName: l.variant.product.name,
      },
      invoiceLine: l.invoiceLine
        ? {
            id: l.invoiceLine.id,
            invoice: l.invoiceLine.invoice,
          }
        : null,
      imageUrl: resolveLineImageUrl(l.variant),
      stock: {
        onHand: totalOnHand,
        available: totalOnHand - totalReserved,
      },
    };
  });

  const applicationRows: CmApplicationRow[] = cm.applications.map((a) => ({
    id: a.id,
    invoiceId: a.invoiceId,
    invoiceNumber: a.invoice.number,
    amount: a.amount,
    appliedAt: a.appliedAt,
    reversedAt: a.reversedAt,
    notes: a.notes,
  }));

  // Available = netCredit − applied. Only meaningful on CONFIRMED.
  const available = cm.netCredit.minus(cm.appliedAmount).toString();

  // Show the applications card on CONFIRMED + VOIDED (when history
  // exists). DRAFT without any apps gets nothing.
  const showApplicationsCard =
    cm.status !== 'DRAFT' || applicationRows.length > 0;

  return (
    <div className="space-y-6">
      <CreditMemoHeader
        cm={{
          id: cm.id,
          number: cm.number,
          status: cm.status,
          customer: cm.customer,
          invoice: cm.invoice,
          rma: cm.rma,
          category: cm.category,
          createdAt: cm.createdAt,
          issuedAt: cm.issuedAt,
          voidedAt: cm.voidedAt,
          hasApplications,
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <CreditMemoLinesTable lines={lineRows} />

          {showApplicationsCard ? (
            <ApplicationsCard
              creditMemoId={cm.id}
              creditMemoNumber={cm.number}
              creditMemoStatus={cm.status}
              customerId={cm.customerId}
              available={available}
              applications={applicationRows}
            />
          ) : null}

          <CreditMemoInfoCard
            cm={{
              reason: cm.reason,
              voidReason: cm.voidReason,
              category: cm.category,
              currency: cm.currency ?? 'USD',
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTagsEditor
                apiPath={`/api/credit-memos/${cm.id}/tags`}
                initialTags={cm.tags.map((a) => ({
                  id: a.tag.id,
                  name: a.tag.name,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <CreditMemoTotalsCard
            status={cm.status}
            amount={cm.amount}
            restockingFee={cm.restockingFee}
            netCredit={cm.netCredit}
            appliedAmount={cm.appliedAmount}
            currency={cm.currency ?? 'USD'}
          />
        </div>
      </div>
    </div>
  );
}
