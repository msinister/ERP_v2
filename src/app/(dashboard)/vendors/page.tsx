import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { VendorType } from '@/generated/tenant';
import { listVendorsPaged } from '@/server/services/vendors';
import { apBalanceForVendor } from '@/server/services/ap';
import { getTableViewPref } from '@/server/services/userPreferences';
import { getActor } from '@/lib/permissions/getActor';
import { Button } from '@/components/ui/button';
import { VendorsFilters } from './_components/filters';
import { VendorsTable, type VendorRowData } from './_components/table';
import { VendorsPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isVendorType(v: string | undefined): v is VendorType {
  if (!v) return false;
  return Object.values(VendorType).includes(v as VendorType);
}

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const q = pickString(sp.q);
  const typeRaw = pickString(sp.type);
  const type = isVendorType(typeRaw) ? typeRaw : undefined;
  const activeRaw = pickString(sp.active);
  // No param = default (active only). 'all' = no filter; 'false' =
  // inactive only. Anything else falls back to the default.
  const active =
    activeRaw === 'all' ? undefined : activeRaw === 'false' ? false : true;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const actor = await getActor();
  if (!actor) redirect('/login');

  const [page, viewPref] = await Promise.all([
    listVendorsPaged(db, { q, type, active, skip, take }),
    getTableViewPref(db, actor.id, 'table.vendors'),
  ]);

  // Per-row AP balance + primary contact. N+1 by design — pilot scale
  // is ~40-200 rows per page max. AP balance reuses apBalanceForVendor
  // (which already excludes deleted/cancelled bills). Primary contact
  // is one batched query keyed by vendorId.
  const vendorIds = page.rows.map((v) => v.id);
  const [balances, primaryContacts] = await Promise.all([
    Promise.all(page.rows.map((v) => apBalanceForVendor(db, v.id))),
    vendorIds.length > 0
      ? db.vendorContact.findMany({
          where: {
            vendorId: { in: vendorIds },
            isPrimary: true,
            deletedAt: null,
          },
          select: {
            vendorId: true,
            name: true,
            email: true,
            phone: true,
            mobile: true,
          },
        })
      : Promise.resolve(
          [] as Array<{
            vendorId: string;
            name: string;
            email: string | null;
            phone: string | null;
            mobile: string | null;
          }>,
        ),
  ]);

  const contactByVendor = new Map(primaryContacts.map((c) => [c.vendorId, c]));

  const tableRows: VendorRowData[] = page.rows.map((v, i) => {
    const c = contactByVendor.get(v.id);
    return {
      id: v.id,
      code: v.code,
      name: v.name,
      type: v.type,
      primaryContactName: c?.name ?? null,
      primaryContactEmail: c?.email ?? null,
      // VendorContact has both phone + mobile; prefer phone, fall back
      // to mobile so a mobile-only contact still renders.
      primaryContactPhone: c?.phone ?? c?.mobile ?? null,
      // Decimal → number across the Server→Client boundary.
      apBalance: balances[i].apBalance.toNumber(),
      active: v.active,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
          <p className="text-sm text-muted-foreground">
            Vendor master, contacts, addresses, catalog, and AP balance.
          </p>
        </div>
        <Button render={<Link href="/vendors/new" />}>
          <Plus />
          New vendor
        </Button>
      </div>

      <VendorsFilters />

      <VendorsTable rows={tableRows} initialPrefs={viewPref} />

      <VendorsPagination total={page.total} skip={skip} take={take} />
    </div>
  );
}
