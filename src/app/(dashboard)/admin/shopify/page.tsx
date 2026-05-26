import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { getPublicConfig } from '@/server/services/shopifyConfig';
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

export default async function ShopifyAdminPage() {
  // Super-admin gate — same pattern as the admin index.
  const user = await getCurrentUser();
  if (!user?.isSuperAdmin) redirect('/dashboard');

  const cfg = await getPublicConfig(db);
  const configured =
    cfg.storeUrl !== '' && cfg.hasAccessToken && cfg.hasWebhookSecret;

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
          Shopify is the source of truth for product catalog data (name,
          description, images, vendor, category, tags). ERP keeps cost,
          inventory, and pricing — nothing in this pane affects those.
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
                initial={{
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
                  Sync is currently <span className="font-medium">disabled</span>{' '}
                  — webhooks and full-sync will short-circuit until you flip
                  the toggle.
                </p>
              ) : null}
              <ShopifySyncActions configured={configured} />
              {cfg.webhookSubscriptions ? (
                <div className="pt-1 text-xs text-muted-foreground">
                  Registered webhooks:{' '}
                  {Object.keys(cfg.webhookSubscriptions).join(', ') || 'none'}
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
              <ShopifySyncLog run={cfg.lastSync} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
