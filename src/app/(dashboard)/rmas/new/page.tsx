import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listCustomers } from '@/server/services/customers';
import { getRestockingFeeDefault } from '@/server/services/restockingFee';
import { listSalesReps } from '@/server/services/salesReps';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { getActor } from '@/lib/permissions/getActor';
import { customerScopeWhere } from '@/lib/permissions/scope';
import {
  RmaForm,
  type CustomerOption,
  type VariantOption,
  type RestockingFeeDefault,
} from '../_components/rma-form';

export const revalidate = 0;

export default async function NewRmaPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Catalog snapshot for client-side variantId → SKU/product joining on
  // the invoice-line rows. Pilot scale (a few hundred variants) keeps
  // this cheap; if the catalog grows past ~5k variants this should move
  // to a /api/variants?ids= endpoint driven off the loaded invoice. The
  // customer picker is scoped to the rep's own customers under "view own".
  const [customers, variants, restockingDefault, salesReps, paymentTerms] =
    await Promise.all([
    listCustomers(db, {
      active: true,
      take: 1000,
      scope: customerScopeWhere(actor),
    }),
    db.productVariant.findMany({
      where: {
        deletedAt: null,
        product: { deletedAt: null },
      },
      include: {
        product: { select: { name: true } },
      },
      orderBy: { sku: 'asc' },
      take: 5000,
    }),
    getRestockingFeeDefault(db),
    listSalesReps(db, { active: true, take: 1000 }),
    listPaymentTerms(db, { active: true }),
  ]);

  const customerOptions: CustomerOption[] = customers.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
  }));
  const variantOptions: VariantOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    variantName: v.name,
    productName: v.product.name,
  }));
  const restockingFeeDefault: RestockingFeeDefault = {
    percent: restockingDefault.percent?.toString() ?? null,
    flat: restockingDefault.flat?.toString() ?? null,
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/rmas"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          RMAs
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New RMA</h1>
          <p className="text-sm text-muted-foreground">
            Authorize a customer return against an existing invoice. The
            RMA starts in Pending Review; the credit memo posts only when
            you reach the Inspected → Credited step.
          </p>
        </div>
      </div>

      <RmaForm
        customers={customerOptions}
        variants={variantOptions}
        restockingFeeDefault={restockingFeeDefault}
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
