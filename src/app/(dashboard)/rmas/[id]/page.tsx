import { notFound } from 'next/navigation';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import {
  lineItemImageVariantSelect,
  resolveLineImageUrl,
} from '@/lib/products/lineItemImage';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { rmaScopeWhere } from '@/lib/permissions/scope';
import {
  getRestockingFeeDefault,
  resolveRestockingFee,
} from '@/server/services/restockingFee';
import { listCategories } from '@/server/services/creditMemoCategories';
import { RmaHeader } from './_components/header';
import { RmaLinesTable, type RmaLineRow } from './_components/lines-table';
import { RmaInfoCard } from './_components/info-card';
import { RmaTotalsCard } from './_components/totals-card';
import { LifecycleActions } from './_components/lifecycle-actions';
import type { CategoryOption } from './_components/issue-credit-dialog';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OrderTagsEditor } from '@/components/shared/order-tags-editor';

export const revalidate = 0;

export default async function RmaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await requirePagePermission([
    'rmas.view_all',
    'rmas.view_own',
  ]);

  const [rma, restockingDefault, categories] = await Promise.all([
    db.rma.findFirst({
      where: { AND: [{ id, deletedAt: null }, rmaScopeWhere(actor)] },
      include: {
        customer: { select: { id: true, code: true, name: true } },
        invoice: {
          select: { id: true, number: true, invoiceDate: true, total: true },
        },
        creditMemo: {
          select: { id: true, number: true, status: true },
        },
        lines: {
          where: { deletedAt: null },
          include: {
            invoiceLine: {
              select: {
                id: true,
                description: true,
                qty: true,
                qtyReturned: true,
                unitPrice: true,
                variantId: true,
                variant: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
                    ...lineItemImageVariantSelect,
                    product: {
                      select: {
                        name: true,
                        // images already pulled via lineItemImageVariantSelect
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
        tags: {
          include: { tag: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    getRestockingFeeDefault(db),
    listCategories(db, { active: true, take: 200 }),
  ]);
  if (!rma) notFound();

  const zero = new Prisma.Decimal(0);
  let grossTotal = zero;
  const lineRows: RmaLineRow[] = rma.lines.map((l) => {
    const lineTotal = l.qty.times(l.invoiceLine.unitPrice);
    grossTotal = grossTotal.plus(lineTotal);
    return {
      id: l.id,
      invoiceLineId: l.invoiceLineId,
      qty: l.qty,
      reason: l.reason,
      invoiceQty: l.invoiceLine.qty,
      invoiceQtyReturned: l.invoiceLine.qtyReturned,
      unitPrice: l.invoiceLine.unitPrice,
      lineTotal,
      description: l.invoiceLine.description,
      variant: {
        id: l.invoiceLine.variant.id,
        sku: l.invoiceLine.variant.sku,
        name: l.invoiceLine.variant.name,
        productName: l.invoiceLine.variant.product.name,
      },
      imageUrl: resolveLineImageUrl(l.invoiceLine.variant),
    };
  });

  // Resolve effective restocking fee (RMA override → admin default → none).
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
  // Guard against negative net credit on display.
  if (restockingFeeAmount.greaterThan(grossTotal)) {
    restockingFeeAmount = grossTotal;
  }
  const netCredit = grossTotal.minus(restockingFeeAmount);

  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    id: c.id,
    code: c.code,
    label: c.label,
    affectsInventory: c.affectsInventory,
  }));

  return (
    <div className="space-y-6">
      <RmaHeader
        rma={{
          id: rma.id,
          number: rma.number,
          status: rma.status,
          returnless: rma.returnless,
          customer: rma.customer,
          invoice: rma.invoice,
          creditMemo: rma.creditMemo,
          createdAt: rma.createdAt,
          approvedAt: rma.approvedAt,
          receivedAt: rma.receivedAt,
          inspectedAt: rma.inspectedAt,
          creditedAt: rma.creditedAt,
          rejectedAt: rma.rejectedAt,
        }}
      />

      <LifecycleActions
        rmaId={rma.id}
        rmaNumber={rma.number}
        status={rma.status}
        returnless={rma.returnless}
        creditMemoId={rma.creditMemo?.id ?? null}
        lines={lineRows.map((l) => ({
          invoiceLineId: l.invoiceLineId,
          qty: l.qty.toString(),
          unitPrice: l.unitPrice.toString(),
          description: l.description,
          variantSku: l.variant.sku,
          productName: l.variant.productName,
          variantName: l.variant.name,
        }))}
        categories={categoryOptions}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <RmaLinesTable lines={lineRows} />

          <RmaInfoCard
            rma={{
              reason: rma.reason,
              rejectedReason: rma.rejectedReason,
              returnless: rma.returnless,
              restockingFeePercent:
                rma.restockingFeePercent?.toString() ?? null,
              restockingFeeFlat: rma.restockingFeeFlat?.toString() ?? null,
              effective,
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTagsEditor
                apiPath={`/api/rmas/${rma.id}/tags`}
                initialTags={rma.tags.map((a) => ({
                  id: a.tag.id,
                  name: a.tag.name,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <RmaTotalsCard
            grossTotal={grossTotal}
            restockingFeeAmount={restockingFeeAmount}
            netCredit={netCredit}
          />
        </div>
      </div>
    </div>
  );
}
