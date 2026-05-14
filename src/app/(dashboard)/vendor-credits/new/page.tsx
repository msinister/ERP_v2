import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listVendors } from '@/server/services/vendors';
import { VcForm, type VendorOption } from '../_components/vc-form';

export const revalidate = 0;

export default async function NewVendorCreditPage() {
  const vendors = await listVendors(db, { active: true, take: 1000 });

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    defaultCurrency: v.defaultCurrency,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/vendor-credits"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Vendor Credits
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            New vendor credit
          </h1>
          <p className="text-sm text-muted-foreground">
            Create a draft. Confirm posts the GL leg (DR AP / CR Vendor
            Credits Available). Lines sum must equal the header amount.
          </p>
        </div>
      </div>

      <VcForm mode={{ kind: 'create' }} vendors={vendorOptions} />
    </div>
  );
}
