import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { getStore } from '@/server/services/shopifyStores';
import type {
  StoredSyncRun,
  StoredPushRun,
  StoredOrderSyncRun,
} from '@/server/services/shopifyStores';
import {
  listRules,
  matchingProductIds,
} from '@/server/services/shopifyStoreRules';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { StoreEditForm, type CustomerTypeValue } from './_components/store-edit-form';
import { StoreSyncActions } from './_components/store-sync-actions';
import { StoreLastRuns } from './_components/store-last-runs';
import { RuleBuilder, type RuleRow } from './_components/rule-builder';
import { ArchiveStoreAction } from './_components/archive-store-action';

export const revalidate = 0;

export default async function ShopifyStoreDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission('admin.edit_settings');

  const { id } = await params;
  const store = await getStore(db, id);
  if (!store) notFound();

  // Rules + match-count preview run alongside the rule-builder's option
  // lists. All small datasets — single round-trip each.
  const [
    rules,
    matchCount,
    vendorOptions,
    categoryOptions,
    tagOptions,
    warehouses,
    salesReps,
    paymentTerms,
  ] = await Promise.all([
    listRules(db, id),
    matchingProductIds(db, id).then((ids) => ids.length),
    db.vendor.findMany({
      where: { active: true, deletedAt: null },
      select: { name: true },
      orderBy: { name: 'asc' },
    }),
    db.product
      .findMany({
        where: { active: true, deletedAt: null, category: { not: null } },
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      })
      .then((rows) =>
        rows
          .map((r) => r.category)
          .filter((c): c is string => c != null && c !== ''),
      ),
    db.tag.findMany({
      select: { name: true },
      orderBy: { name: 'asc' },
    }),
    db.warehouse.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
    db.salesRep.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
    db.paymentTerm.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, code: true, label: true },
      orderBy: { code: 'asc' },
    }),
  ]);

  const ruleRows: RuleRow[] = rules.map((r) => ({
    id: r.id,
    ruleType: r.ruleType,
    value: r.value,
    sortOrder: r.sortOrder,
  }));

  const configured =
    store.storeUrl !== '' && store.hasAccessToken && store.hasWebhookSecret;
  const pushReady = configured && store.shopifyLocationId != null;
  const orderSyncReady =
    configured &&
    store.orderSyncEnabled &&
    store.defaultWarehouseId != null &&
    store.defaultSalesRepId != null &&
    store.defaultPaymentTermId != null &&
    store.defaultCustomerType != null;

  const lastSync = store.lastSyncResult as StoredSyncRun | null;
  const lastPush = store.lastPushResult as StoredPushRun | null;
  const lastOrderSync = store.lastOrderSyncResult as StoredOrderSyncRun | null;
  const webhookSubscriptions = (store.webhookSubscriptionIds ?? null) as Record<
    string,
    string
  > | null;

  return (
    <div className="space-y-6">
      <Link
        href="/admin/shopify"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Shopify stores
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {store.name}
            </h1>
            {!store.active ? (
              <Badge variant="outline" className="text-muted-foreground">
                Inactive
              </Badge>
            ) : null}
            {store.syncEnabled ? (
              <Badge variant="secondary">Sync on</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Sync off
              </Badge>
            )}
            {store.inventoryPushEnabled ? (
              <Badge variant="secondary">Push on</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Push off
              </Badge>
            )}
            {store.orderSyncEnabled ? (
              <Badge variant="secondary">Order sync on</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Order sync off
              </Badge>
            )}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {store.storeUrl}
          </div>
        </div>
        <ArchiveStoreAction storeId={store.id} storeName={store.name} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Connection</CardTitle>
            </CardHeader>
            <CardContent>
              <StoreEditForm
                storeId={store.id}
                initial={{
                  name: store.name,
                  storeUrl: store.storeUrl,
                  hasAccessToken: store.hasAccessToken,
                  hasWebhookSecret: store.hasWebhookSecret,
                  syncEnabled: store.syncEnabled,
                  inventoryPushEnabled: store.inventoryPushEnabled,
                  orderSyncEnabled: store.orderSyncEnabled,
                  shopifyLocationId: store.shopifyLocationId,
                  defaultWarehouseId: store.defaultWarehouseId,
                  defaultSalesRepId: store.defaultSalesRepId,
                  defaultPaymentTermId: store.defaultPaymentTermId,
                  defaultCustomerType:
                    (store.defaultCustomerType as CustomerTypeValue | null) ?? null,
                  active: store.active,
                }}
                options={{ warehouses, salesReps, paymentTerms }}
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
                  Save store URL, access token, and webhook secret to enable
                  test / register / sync actions.
                </p>
              ) : null}
              {configured && !store.syncEnabled ? (
                <p className="text-xs text-muted-foreground">
                  Sync is currently{' '}
                  <span className="font-medium">disabled</span> — webhooks and
                  full-sync will short-circuit until you flip the toggle.
                </p>
              ) : null}
              {configured && !pushReady ? (
                <p className="text-xs text-muted-foreground">
                  Set the Shopify location id to enable inventory push.
                </p>
              ) : null}
              {configured && store.orderSyncEnabled && !orderSyncReady ? (
                <p className="text-xs text-muted-foreground">
                  Set every order-import default (warehouse, sales rep,
                  payment terms, customer type) to enable order sync.
                </p>
              ) : null}
              <StoreSyncActions
                storeId={store.id}
                configured={configured}
                pushEnabled={store.inventoryPushEnabled && pushReady}
                orderSyncReady={orderSyncReady}
              />
              {webhookSubscriptions ? (
                <div className="pt-1 text-xs text-muted-foreground">
                  Registered webhooks:{' '}
                  {Object.keys(webhookSubscriptions).join(', ') || 'none'}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Routing rules</CardTitle>
            </CardHeader>
            <CardContent>
              <RuleBuilder
                storeId={store.id}
                initialRules={ruleRows}
                initialMatchCount={matchCount}
                vendorOptions={vendorOptions.map((v) => v.name)}
                categoryOptions={categoryOptions}
                tagOptions={tagOptions.map((t) => t.name)}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <StoreLastRuns
            sync={lastSync}
            push={lastPush}
            orderSync={lastOrderSync}
          />
        </div>
      </div>
    </div>
  );
}
