import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCreditMemo } from '@/server/services/creditMemos';
import { listCustomers } from '@/server/services/customers';
import { listCategories } from '@/server/services/creditMemoCategories';
import {
  CmForm,
  type CustomerOption,
  type CategoryOption,
  type VariantOption,
  type CmFormValues,
} from '../../_components/cm-form';

export const revalidate = 0;

export default async function EditCreditMemoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cm = await getCreditMemo(db, id);
  if (!cm) notFound();
  // Only DRAFT is editable. Bounce to the detail page so the operator
  // doesn't get a half-broken form.
  if (cm.status !== 'DRAFT') {
    redirect(`/credit-memos/${id}`);
  }

  const [customers, categories, variants] = await Promise.all([
    listCustomers(db, { active: true, take: 1000 }),
    listCategories(db, { active: true, take: 200 }),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: {
        product: {
          select: { name: true, shortDescription: true },
        },
      },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
  ]);

  const customerOptions: CustomerOption[] = customers.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
  }));
  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    id: c.id,
    code: c.code,
    label: c.label,
    affectsInventory: c.affectsInventory,
  }));
  const variantOptions: VariantOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    variantName: v.name,
    productName: v.product.name,
    shortDescription: v.product.shortDescription,
  }));

  // creditDate intentionally omitted — the form defaults it to today.
  // The field is informational only (not stored on the memo), and an
  // edit re-opens the draft "as of today" rather than the original
  // create date.
  const defaultValues: Partial<CmFormValues> = {
    customerId: cm.customerId,
    invoiceId: cm.invoiceId ?? '',
    categoryId: cm.categoryId,
    restockingFee: cm.restockingFee.greaterThan(0)
      ? cm.restockingFee.toString()
      : '',
    currency: cm.currency && cm.currency !== 'USD' ? cm.currency : '',
    reason: cm.reason ?? '',
    lines: cm.lines.map((l) => ({
      invoiceLineId: l.invoiceLineId ?? '',
      variantId: l.variantId,
      qty: l.qty.toString(),
      unitPrice: l.unitPrice.toString(),
      description: l.description,
    })),
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/credit-memos/${cm.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {cm.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit credit memo
          </h1>
          <p className="text-sm text-muted-foreground">
            Only DRAFT memos are editable. Confirming locks the document.
          </p>
        </div>
      </div>

      <CmForm
        mode={{ kind: 'edit', creditMemoId: cm.id }}
        customers={customerOptions}
        categories={categoryOptions}
        variants={variantOptions}
        defaultValues={defaultValues}
      />
    </div>
  );
}
