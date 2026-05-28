import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listVendors } from '@/server/services/vendors';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { VcForm, type VendorOption } from '../_components/vc-form';

export const revalidate = 0;

export default async function NewVendorCreditPage() {
  await requirePagePermission('bills.create');
  const [vendors, paymentTerms] = await Promise.all([
    listVendors(db, { active: true, take: 1000 }),
    listPaymentTerms(db, { active: true }),
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    defaultCurrency: v.defaultCurrency,
  }));
  // Payment terms for the inline "create vendor" dialog (required field).
  const paymentTermOptions = paymentTerms.map((t) => ({
    id: t.id,
    label: t.netDays === null ? t.label : `${t.label} (net ${t.netDays})`,
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
            Credits Available).
          </p>
        </div>
      </div>

      <VcForm
        mode={{ kind: 'create' }}
        vendors={vendorOptions}
        paymentTerms={paymentTermOptions}
      />
    </div>
  );
}
