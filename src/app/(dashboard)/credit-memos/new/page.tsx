import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listCustomers } from '@/server/services/customers';
import { listCategories } from '@/server/services/creditMemoCategories';
import {
  CmForm,
  type CustomerOption,
  type CategoryOption,
  type VariantOption,
} from '../_components/cm-form';

export const revalidate = 0;

export default async function NewCreditMemoPage() {
  // Pilot scale: a few dozen customers, a few dozen variants. One fetch
  // each — no per-line API search. Invoices for the picked customer
  // load client-side via /api/invoices?customerId=… so we don't pull
  // every invoice upfront.
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
          select: {
            name: true,
            shortDescription: true,
          },
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

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/credit-memos"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Credit Memos
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            New credit memo
          </h1>
          <p className="text-sm text-muted-foreground">
            Create a draft. Confirm posts DR Sales Returns / CR AR, plus
            the restocking-fee chargeback when set, and auto-applies to
            the linked invoice.
          </p>
        </div>
      </div>

      <CmForm
        mode={{ kind: 'create' }}
        customers={customerOptions}
        categories={categoryOptions}
        variants={variantOptions}
      />
    </div>
  );
}
