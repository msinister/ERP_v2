import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getBill } from '@/server/services/bills';
import { listVendors } from '@/server/services/vendors';
import { listAccounts } from '@/server/services/glAccounts';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import {
  BillForm,
  type BillFormValues,
  type CatalogHint,
  type VendorOption,
  type VariantOption,
  type ExpenseAccountOption,
} from '../../_components/bill-form';

export const revalidate = 0;

export default async function EditBillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [bill, vendors, variants, allAccounts, catalogRows, paymentTerms] =
    await Promise.all([
    getBill(db, id),
    listVendors(db, { active: true, take: 1000 }),
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: {
        product: { select: { name: true, shortDescription: true } },
      },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
    listAccounts(db, { active: true, take: 500 }),
    db.vendorProduct.findMany({
      where: { deletedAt: null },
      select: {
        vendorId: true,
        variantId: true,
        vendorSku: true,
        latestCost: true,
      },
      take: 5000,
    }),
    listPaymentTerms(db, { active: true }),
  ]);
  if (!bill) notFound();

  // Edit is only allowed in DRAFT (service-side wholesale-replace
  // semantics). Surface as a redirect to detail rather than letting
  // the form load and then fail on submit.
  if (bill.status !== 'DRAFT') {
    redirect(`/bills/${bill.id}`);
  }

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    defaultCurrency: v.defaultCurrency,
  }));
  // If the bill points at a deactivated vendor, inject it so the
  // disabled-on-edit Select still has a label to render.
  if (!vendorOptions.find((v) => v.id === bill.vendorId)) {
    const v = await db.vendor.findUnique({ where: { id: bill.vendorId } });
    if (v) {
      vendorOptions.push({
        id: v.id,
        code: v.code,
        name: v.name,
        defaultCurrency: v.defaultCurrency,
      });
    }
  }
  const variantOptions: VariantOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    variantName: v.name,
    productName: v.product.name,
    shortDescription: v.product.shortDescription,
  }));
  const catalogHints: CatalogHint[] = catalogRows.map((r) => ({
    vendorId: r.vendorId,
    variantId: r.variantId,
    vendorSku: r.vendorSku,
    latestCost: r.latestCost?.toString() ?? null,
  }));
  const expenseAccountOptions: ExpenseAccountOption[] = allAccounts
    .filter((a) => a.type === AccountType.EXPENSE)
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));
  // Payment terms for the inline "create vendor" dialog (required field).
  const paymentTermOptions = paymentTerms.map((t) => ({
    id: t.id,
    label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
  }));

  const defaults: Partial<BillFormValues> = {
    vendorId: bill.vendorId,
    source: bill.source as 'PRODUCT' | 'EXPENSE',
    vendorReference: bill.vendorReference ?? '',
    billDate: bill.billDate.toISOString().slice(0, 10),
    currency: bill.currency ?? '',
    notes: bill.notes ?? '',
    lines: bill.lines.map((l) => ({
      variantId: l.variantId ?? undefined,
      expenseAccountId: l.expenseAccountId ?? undefined,
      description: l.description,
      qty: l.qty.toString(),
      unitCost: l.unitCost.toString(),
      notes: l.notes ?? '',
    })),
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/bills/${bill.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {bill.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit bill</h1>
          <p className="text-sm text-muted-foreground">
            Only DRAFT bills can be edited. Lines are wholesale-replaced
            on save. Vendor and source are fixed.
          </p>
        </div>
      </div>

      <BillForm
        mode={{ kind: 'edit', billId: bill.id }}
        vendors={vendorOptions}
        paymentTerms={paymentTermOptions}
        variants={variantOptions}
        catalogHints={catalogHints}
        expenseAccounts={expenseAccountOptions}
        defaultValues={defaults}
      />
    </div>
  );
}
