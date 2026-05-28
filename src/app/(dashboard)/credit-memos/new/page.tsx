import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listCustomers } from '@/server/services/customers';
import { listCategories } from '@/server/services/creditMemoCategories';
import { listSalesReps } from '@/server/services/salesReps';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { customerScopeWhere } from '@/lib/permissions/scope';
import {
  CmForm,
  type CustomerOption,
  type CategoryOption,
  type VariantOption,
} from '../_components/cm-form';

export const revalidate = 0;

export default async function NewCreditMemoPage() {
  const actor = await requirePagePermission('credit_memos.create');
  // Pilot scale: a few dozen customers, a few dozen variants. One fetch
  // each — no per-line API search. Invoices for the picked customer
  // load client-side via /api/invoices?customerId=… so we don't pull
  // every invoice upfront. The customer picker is scoped to the rep's
  // own customers under "view own".
  const [customers, categories, variants, salesReps, paymentTerms] =
    await Promise.all([
    listCustomers(db, {
      active: true,
      take: 1000,
      scope: customerScopeWhere(actor),
    }),
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
    listSalesReps(db, { active: true, take: 1000 }),
    listPaymentTerms(db, { active: true }),
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
        salesReps={salesReps.map((r) => ({ id: r.id, name: r.name }))}
        paymentTerms={paymentTerms.map((t) => ({
          id: t.id,
          label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
        }))}
        defaultSalesRepId={actor.salesRepId}
      />
    </div>
  );
}
