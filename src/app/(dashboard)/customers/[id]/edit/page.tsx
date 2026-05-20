import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCustomer } from '@/server/services/customers';
import { listSalesReps } from '@/server/services/salesReps';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { getActor } from '@/lib/permissions/getActor';
import { customerScopeWhere } from '@/lib/permissions/scope';
import {
  CustomerForm,
  type CustomerFormValues,
} from '../../_components/customer-form';

export const revalidate = 0;

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const [customer, salesReps, paymentTerms] = await Promise.all([
    getCustomer(db, id, customerScopeWhere(actor)),
    listSalesReps(db, { active: true }),
    listPaymentTerms(db, { active: true }),
  ]);
  if (!customer) notFound();

  const defaults: Partial<CustomerFormValues> = {
    name: customer.name,
    type: customer.type,
    salesRepId: customer.salesRepId,
    paymentTermId: customer.paymentTermId,
    primaryPhone: customer.primaryPhone ?? '',
    primaryEmail: customer.primaryEmail ?? '',
    creditLimit: customer.creditLimit?.toString() ?? '',
    arHoldDays:
      customer.arHoldDays === null ? '' : String(customer.arHoldDays),
    taxExempt: customer.taxExempt,
    resaleCertNumber: customer.resaleCertNumber ?? '',
    internalNotes: customer.internalNotes ?? '',
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/customers/${customer.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {customer.name}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit customer
          </h1>
          <p className="text-sm text-muted-foreground">
            Billing and shipping addresses are managed from the{' '}
            <Link
              href={`/customers/${customer.id}?tab=addresses`}
              className="underline-offset-2 hover:underline"
            >
              Addresses tab
            </Link>
            .
          </p>
        </div>
      </div>

      <CustomerForm
        mode={{ kind: 'edit', customerId: customer.id }}
        salesReps={salesReps.map((r) => ({ id: r.id, label: r.name }))}
        paymentTerms={paymentTerms.map((t) => ({
          id: t.id,
          label:
            t.netDays === null
              ? `${t.label} (COD)`
              : `${t.label} (net ${t.netDays})`,
        }))}
        defaultValues={defaults}
      />
    </div>
  );
}
