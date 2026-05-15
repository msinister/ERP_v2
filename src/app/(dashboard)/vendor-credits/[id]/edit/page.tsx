import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getVendorCredit } from '@/server/services/vendorCredits';
import { listVendors } from '@/server/services/vendors';
import {
  VcForm,
  type VcFormValues,
  type VendorOption,
} from '../../_components/vc-form';

export const revalidate = 0;

export default async function EditVendorCreditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [vc, vendors] = await Promise.all([
    getVendorCredit(db, id),
    listVendors(db, { active: true, take: 1000 }),
  ]);
  if (!vc) notFound();

  // Edit is only allowed in DRAFT (service-side wholesale-replace
  // semantics). Surface as redirect so the form doesn't load just to
  // fail on submit.
  if (vc.status !== 'DRAFT') {
    redirect(`/vendor-credits/${vc.id}`);
  }

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    code: v.code,
    name: v.name,
    defaultCurrency: v.defaultCurrency,
  }));
  if (!vendorOptions.find((v) => v.id === vc.vendorId)) {
    const v = await db.vendor.findUnique({ where: { id: vc.vendorId } });
    if (v) {
      vendorOptions.push({
        id: v.id,
        code: v.code,
        name: v.name,
        defaultCurrency: v.defaultCurrency,
      });
    }
  }

  const defaults: Partial<VcFormValues> = {
    vendorId: vc.vendorId,
    creditDate: vc.creditDate.toISOString().slice(0, 10),
    currency: vc.currency ?? '',
    reason: vc.reason ?? '',
    notes: vc.notes ?? '',
    lines: vc.lines.map((l) => ({
      description: l.description,
      amount: l.amount.toString(),
      notes: l.notes ?? '',
    })),
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/vendor-credits/${vc.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {vc.number}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit vendor credit
          </h1>
          <p className="text-sm text-muted-foreground">
            Only DRAFT credits can be edited. Lines are wholesale-replaced
            on save. Vendor is fixed.
          </p>
        </div>
      </div>

      <VcForm
        mode={{ kind: 'edit', vendorCreditId: vc.id }}
        vendors={vendorOptions}
        defaultValues={defaults}
      />
    </div>
  );
}
