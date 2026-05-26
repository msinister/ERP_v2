import Link from 'next/link';
import { Plus } from 'lucide-react';
import { VendorCreditStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { listVendorCreditsPaged } from '@/server/services/vendorCredits';
import { listVendors } from '@/server/services/vendors';
import { listAllOrderTags } from '@/server/services/orderTags';
import { Button } from '@/components/ui/button';
import {
  VendorCreditsFilters,
  type VendorOption,
} from './_components/filters';
import {
  VendorCreditsTable,
  type VendorCreditRowData,
} from './_components/table';
import { VendorCreditsPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isVendorCreditStatus(
  v: string | undefined,
): v is VendorCreditStatus {
  if (!v) return false;
  return Object.values(VendorCreditStatus).includes(v as VendorCreditStatus);
}

export default async function VendorCreditsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const statusRaw = pickString(sp.status);
  const status = isVendorCreditStatus(statusRaw) ? statusRaw : undefined;
  const vendorId = pickString(sp.vendorId);
  const tagsParam = pickString(sp.tags);
  const tagIds = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [vendors, allOrderTags, page] = await Promise.all([
    listVendors(db, { active: true, take: 1000 }),
    listAllOrderTags(db),
    listVendorCreditsPaged(db, { q, status, vendorId, tagIds, skip, take }),
  ]);

  const vendorOptions: VendorOption[] = vendors.map((v) => ({
    id: v.id,
    label: `${v.name} (${v.code})`,
  }));
  const tagOptions = allOrderTags.map((t) => ({ id: t.id, name: t.name }));

  const tableRows: VendorCreditRowData[] = page.rows.map((vc) => ({
    id: vc.id,
    number: vc.number,
    vendorId: vc.vendor.id,
    vendorCode: vc.vendor.code,
    vendorName: vc.vendor.name,
    creditDate: vc.creditDate,
    amount: vc.amount,
    appliedAmount: vc.appliedAmount,
    status: vc.status,
    // sourceTag = "OVERPAYMENT:<billPaymentId>" when auto-created by
    // the bill-payment overpayment path. Anything else (null or
    // other prefix) is treated as manual entry.
    isOverpayment: !!vc.sourceTag && vc.sourceTag.startsWith('OVERPAYMENT:'),
    tags: vc.tags.map((a) => ({ id: a.tag.id, name: a.tag.name })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Vendor Credits
          </h1>
          <p className="text-sm text-muted-foreground">
            Draft → Confirmed → Cancelled. Confirmed credits post DR AP /
            CR Vendor Credits Available; applying them to a bill is a
            separate action.
          </p>
        </div>
        <Button render={<Link href="/vendor-credits/new" />}>
          <Plus />
          New credit
        </Button>
      </div>

      <VendorCreditsFilters vendors={vendorOptions} tags={tagOptions} />

      <VendorCreditsTable rows={tableRows} />

      <VendorCreditsPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
