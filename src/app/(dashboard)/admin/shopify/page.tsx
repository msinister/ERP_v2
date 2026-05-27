import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { getDefaultStore } from '@/server/services/shopifyStores';
import type { StoredSyncRun } from '@/server/services/shopifyStores';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ShopifyConfigForm } from './_components/config-form';
import { ShopifySyncActions } from './_components/sync-actions';
import { ShopifySyncLog } from './_components/sync-log';

export const revalidate = 0;

// Slice A admin shim: operates on the first active ShopifyStore (the row
// that the migration created from the legacy Setting blob). Slice B
// replaces this with a multi-store list + per-store rule builder.
export default async function ShopifyAdminPage() {
  const user = await getCurrentUser();
  if (!user?.isSuperAdmin) redirect('/dashboard');

  const cfg = await getDefaultStore(db);

  if (!cfg) {
    return (
      <div className="space-y-6">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Shopify sync</h1>
          <p className="text-sm text-muted-foreground">
            No Shopify store is configured. Create one with{' '}
            <code>POST /api/admin/shopify/stores</code> (multi-store admin UI
            ships in the next slice).
          </p>
        </div>
      </div>
    );
  }

  const configured =
    cfg.storeUrl !== '' && cfg.hasAccessToken && cfg.hasWebhookSecret;
  const lastSync = cfg.lastSyncResult as StoredSyncRun | null;
  const webhookSubscriptions = (cfg.webhookSubscriptionIds ?? null) as Record<
    string,
    string
  > | null;

  return (
    <div className="space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Admin
      </Link>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Shopify sync</h1>
        <p className="text-sm text-muted-foreground">
          Showing the default Shopify store ({cfg.name}). Multi-store
          management UI is in the next slice — use the API for additional
          stores in the meantime.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <ShopifyConfigForm
                storeId={cfg.id}
                initial={{
                  name: cfg.name,
                  storeUrl: cfg.storeUrl,
                  hasAccessToken: cfg.hasAccessToken,
                  hasWebhookSecret: cfg.hasWebhookSecret,
                  syncEnabled: cfg.syncEnabled,
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!configured ? (
                <p className="text-xs text-muted-foreground">
                  Save the store URL, access token, and webhook secret first.
                </p>
              ) : !cfg.syncEnabled ? (
                <p className="text-xs text-muted-foreground">
                  Sync is currently{' '}
                  <span className="font-medium">disabled</span> — webhooks and
                  full-sync will short-circuit until you flip the toggle.
                </p>
              ) : null}
              <ShopifySyncActions storeId={cfg.id} configured={configured} />
              {webhookSubscriptions ? (
                <div className="pt-1 text-xs text-muted-foreground">
                  Registered webhooks:{' '}
                  {Object.keys(webhookSubscriptions).join(', ') || 'none'}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Last sync</CardTitle>
            </CardHeader>
            <CardContent>
              <ShopifySyncLog run={lastSync} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
