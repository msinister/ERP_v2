import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SETTING_KEYS } from '@/lib/validation/settings';
import { RestockingFeeForm } from './_components/restocking-fee-form';
import { TierDiscountForm } from './_components/tier-discount-form';
import { CommissionCycleForm } from './_components/commission-cycle-form';
import { NegativeInventoryForm } from './_components/negative-inventory-form';
import { OverShippingPolicyForm } from './_components/over-shipping-policy-form';
import {
  CompanyInfoForm,
  type CompanyInfoOnDisk,
} from './_components/company-info-form';
import type { OverShippingPolicyValue } from '@/lib/validation/settings';

export const revalidate = 0;

// Each setting's on-disk shape is registered in lib/validation/settings.ts.
// We read the raw JSON value here and cast at the boundary to the
// matching component prop type — the schemas already validated whatever
// landed on disk, so the cast is safe for the GUI's purposes.

type RestockingFeeOnDisk = { percent: string | null; flat: string | null };
type TiersOnDisk = {
  WHOLESALE_REGULAR: string;
  WHOLESALE_PREFERRED: string;
  WHOLESALE_DISTRIBUTOR: string;
  WHOLESALE_MASTER_DISTRIBUTOR: string;
  RETAIL: string;
};
type CommissionCycleOnDisk = {
  kind: 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY';
  anchorDay?: number;
};
type NegativeInventoryOnDisk = { allowed: boolean };
type OverShippingPolicyOnDisk = { policy: OverShippingPolicyValue };

export default async function AdminSettingsPage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const rows = await db.setting.findMany({
    where: {
      key: { in: Object.values(SETTING_KEYS) },
    },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value as unknown]));

  const restockingFee =
    (byKey.get(SETTING_KEYS.RESTOCKING_FEE_DEFAULT) as
      | RestockingFeeOnDisk
      | undefined) ?? { percent: null, flat: null };
  const tiers =
    (byKey.get(SETTING_KEYS.TIER_DISCOUNT_PERCENTAGES) as
      | TiersOnDisk
      | undefined) ?? null;
  const cycle =
    (byKey.get(SETTING_KEYS.COMMISSION_PAYOUT_CYCLE) as
      | CommissionCycleOnDisk
      | undefined) ?? null;
  const negInv =
    (byKey.get(SETTING_KEYS.NEGATIVE_INVENTORY_ALLOWED) as
      | NegativeInventoryOnDisk
      | undefined) ?? null;
  const overShipping =
    (byKey.get(SETTING_KEYS.OVER_SHIPPING_POLICY) as
      | OverShippingPolicyOnDisk
      | undefined) ?? null;
  const companyInfo =
    (byKey.get(SETTING_KEYS.COMPANY_INFO) as CompanyInfoOnDisk | undefined) ??
    null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Tenant-wide configuration. Saves go through the audit log
            (UPDATE on the Setting entity, before + after).
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Financial
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Restocking fee default</CardTitle>
            </CardHeader>
            <CardContent>
              <RestockingFeeForm initial={restockingFee} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Commission payout cycle</CardTitle>
            </CardHeader>
            <CardContent>
              <CommissionCycleForm initial={cycle} />
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">
                Tier discount percentages
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TierDiscountForm initial={tiers} />
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Company
        </h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Company info</CardTitle>
          </CardHeader>
          <CardContent>
            <CompanyInfoForm initial={companyInfo} />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Operations
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Negative inventory</CardTitle>
            </CardHeader>
            <CardContent>
              <NegativeInventoryForm initial={negInv} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Over-shipping policy</CardTitle>
            </CardHeader>
            <CardContent>
              <OverShippingPolicyForm initial={overShipping} />
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
