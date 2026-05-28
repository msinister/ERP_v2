import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { getVendor } from '@/server/services/vendors';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import {
  VendorForm,
  type VendorFormValues,
} from '../../_components/vendor-form';

export const revalidate = 0;

export default async function EditVendorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('vendors.edit');
  const { id } = await params;
  const [vendor, paymentTerms] = await Promise.all([
    getVendor(db, id),
    listPaymentTerms(db, { active: true }),
  ]);
  if (!vendor) notFound();

  const defaults: Partial<VendorFormValues> = {
    name: vendor.name,
    type: vendor.type,
    paymentTermId: vendor.paymentTermId ?? '',
    defaultCurrency: vendor.defaultCurrency ?? '',
    minimumOrderAmount: vendor.minimumOrderAmount?.toString() ?? '',
    costChangeAlertPct: vendor.costChangeAlertPct?.toString() ?? '',
    notes: vendor.notes ?? '',
    active: vendor.active,
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/vendors/${vendor.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {vendor.name}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit vendor</h1>
          <p className="text-sm text-muted-foreground">
            Addresses and contacts are managed from the{' '}
            <Link
              href={`/vendors/${vendor.id}`}
              className="underline-offset-2 hover:underline"
            >
              detail page
            </Link>{' '}
            tabs.
          </p>
        </div>
      </div>

      <VendorForm
        mode={{ kind: 'edit', vendorId: vendor.id }}
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
