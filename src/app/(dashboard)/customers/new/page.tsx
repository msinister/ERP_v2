import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listSalesReps } from '@/server/services/salesReps';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { CustomerForm } from '../_components/customer-form';

// Always live — sales rep / payment term lists may have just been
// edited by an admin and a stale dropdown would be confusing.
export const revalidate = 0;

export default async function NewCustomerPage() {
  const [salesReps, paymentTerms] = await Promise.all([
    listSalesReps(db, { active: true }),
    listPaymentTerms(db, { active: true }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Customers
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            New customer
          </h1>
          <p className="text-sm text-muted-foreground">
            Create a customer record with a billing address. Additional
            ship-tos, contacts, and price overrides can be added from the
            detail page once it&apos;s created.
          </p>
        </div>
      </div>

      <CustomerForm
        mode={{ kind: 'create' }}
        salesReps={salesReps.map((r) => ({ id: r.id, label: r.name }))}
        paymentTerms={paymentTerms.map((t) => ({
          id: t.id,
          label:
            t.netDays === null
              ? `${t.label} (COD)`
              : `${t.label} (net ${t.netDays})`,
        }))}
      />
    </div>
  );
}
