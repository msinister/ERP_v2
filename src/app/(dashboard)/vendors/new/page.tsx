import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { VendorForm } from '../_components/vendor-form';

// Always live — payment term list may have just been edited by an
// admin and a stale dropdown would be confusing. Mirrors the customer
// new page convention.
export const revalidate = 0;

export default async function NewVendorPage() {
  await requirePagePermission('vendors.create');
  const paymentTerms = await listPaymentTerms(db, { active: true });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/vendors"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Vendors
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New vendor</h1>
          <p className="text-sm text-muted-foreground">
            Create a vendor record with a remit-to address. Contacts,
            additional addresses, products, and payment methods can be added
            from the detail page once it&apos;s created.
          </p>
        </div>
      </div>

      <VendorForm
        mode={{ kind: 'create' }}
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
