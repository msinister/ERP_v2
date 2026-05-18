import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listVendors } from '@/server/services/vendors';
import { listAccounts } from '@/server/services/glAccounts';
import {
  BillForm,
  type CatalogHint,
  type VendorOption,
  type VariantOption,
  type ExpenseAccountOption,
} from '../_components/bill-form';

export const revalidate = 0;

export default async function NewBillPage() {
  // Pilot scale: a few dozen vendors, a few dozen variants, a few
  // dozen GL accounts. Fetch all active in one go — no per-line API
  // search. Vendor catalog rows (VendorProduct) provide the picker's
  // vendorSku search corpus + the latestCost auto-fill on select.
  const [vendors, variants, allAccounts, catalogRows] = await Promise.all([
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
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    defaultCurrency: v.defaultCurrency,
  }));
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
  // listAccounts doesn't accept a type filter, so we narrow here. The
  // form needs only EXPENSE accounts for the line picker; the cash
  // account picker (payment recording, slice 7C) will filter to ASSET.
  const expenseAccountOptions: ExpenseAccountOption[] = allAccounts
    .filter((a) => a.type === AccountType.EXPENSE)
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/bills"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Bills
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New bill</h1>
          <p className="text-sm text-muted-foreground">
            Create a draft. Confirm posts the AP JE and sets the due date
            from the vendor&apos;s payment term.
          </p>
        </div>
      </div>

      <BillForm
        mode={{ kind: 'create' }}
        vendors={vendorOptions}
        variants={variantOptions}
        catalogHints={catalogHints}
        expenseAccounts={expenseAccountOptions}
      />
    </div>
  );
}
