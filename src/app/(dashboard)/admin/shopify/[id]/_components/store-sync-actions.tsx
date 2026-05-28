'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Plug,
  RefreshCcw,
  Upload,
  Webhook,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

// Per-store sync controls: test connection, register webhooks, full
// catalog pull, push products to Shopify (ERP → Shopify catalog create),
// push all inventory, sync orders (Shopify → ERP). All call the
// per-store admin routes. Sync Orders is gated on orderSyncEnabled +
// the four order-import defaults; the parent only sets `orderSyncReady`
// true when every gate passes.

export function StoreSyncActions({
  storeId,
  configured,
  pushEnabled,
  orderSyncReady,
}: {
  storeId: string;
  configured: boolean;
  pushEnabled: boolean;
  orderSyncReady: boolean;
}) {
  const router = useRouter();
  const [testing, startTesting] = useTransition();
  const [registering, startRegistering] = useTransition();
  const [syncing, startSyncing] = useTransition();
  const [pushingProducts, startPushingProducts] = useTransition();
  const [pushing, startPushing] = useTransition();
  const [syncingOrders, startSyncingOrders] = useTransition();
  const busy =
    testing ||
    registering ||
    syncing ||
    pushingProducts ||
    pushing ||
    syncingOrders;

  function onTest() {
    startTesting(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/test-connection`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          productCount?: number;
          error?: string;
          status?: number;
        };
        if (!res.ok || body.ok === false) {
          toast.error(
            body.error ??
              `Connection failed${body.status ? ` (${body.status})` : ''}`,
          );
          return;
        }
        toast.success(`Connected — ${body.productCount ?? '?'} products in Shopify`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onRegister() {
    startRegistering(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/register-webhooks`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          created?: string[];
          skipped?: string[];
          base?: string;
          error?: string;
        };
        if (!res.ok || body.ok === false) {
          toast.error(body.error ?? 'Register failed');
          return;
        }
        const newCount = body.created?.length ?? 0;
        const skipCount = body.skipped?.length ?? 0;
        toast.success(
          `Webhooks registered — ${newCount} new, ${skipCount} already wired (base ${body.base})`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onFullSync() {
    startSyncing(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/full-sync`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          created?: number;
          updated?: number;
          skipped?: number;
          errors?: Array<{ shopifyId: string; message: string }>;
          error?: string;
        };
        if (!res.ok) {
          toast.error(body.error ?? `Sync failed (${res.status})`);
          return;
        }
        const errCount = body.errors?.length ?? 0;
        const msg = `Sync complete — ${body.created ?? 0} created, ${body.updated ?? 0} updated, ${body.skipped ?? 0} skipped${errCount > 0 ? `, ${errCount} errors` : ''}`;
        if (errCount > 0) toast.warning(msg);
        else toast.success(msg);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onPushProducts() {
    startPushingProducts(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/push-products`,
          { method: 'POST' },
        );
        // The route returns the StoredSyncRun directly (created / updated /
        // skipped / errors) — same shape as full-sync. Push-products is
        // bi-directional now: products without a primary junction are
        // CREATEd, products with one are UPDATEd in place, so both counters
        // are meaningful in the summary.
        const body = (await res.json().catch(() => ({}))) as {
          created?: number;
          updated?: number;
          skipped?: number;
          errors?: Array<{ shopifyId: string; message: string }>;
          error?: string;
        };
        if (!res.ok) {
          toast.error(body.error ?? `Push failed (${res.status})`);
          return;
        }
        const errCount = body.errors?.length ?? 0;
        const msg = `Product push complete — ${body.created ?? 0} created, ${body.updated ?? 0} updated, ${body.skipped ?? 0} skipped${errCount > 0 ? `, ${errCount} errors` : ''}`;
        if (errCount > 0) toast.warning(msg);
        else toast.success(msg);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onSyncOrders() {
    startSyncingOrders(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/sync-orders`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          run?: {
            imported: number;
            skipped: number;
            pendingReview: number;
            errors: Array<{
              shopifyOrderId: string;
              shopifyOrderNumber: string;
              message: string;
            }>;
          };
          error?: string;
        };
        if (!res.ok || body.ok === false) {
          toast.error(body.error ?? `Order sync failed (${res.status})`);
          return;
        }
        const r = body.run;
        const errCount = r?.errors.length ?? 0;
        const msg = `Order sync complete — ${r?.imported ?? 0} imported, ${r?.skipped ?? 0} skipped, ${r?.pendingReview ?? 0} pending review${errCount > 0 ? `, ${errCount} errors` : ''}`;
        if (errCount > 0 || (r?.pendingReview ?? 0) > 0) toast.warning(msg);
        else toast.success(msg);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function onPushAll() {
    startPushing(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/push-inventory`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          run?: {
            pushed: number;
            skipped: number;
            errors: Array<{ productId: string; storeId: string; message: string }>;
          };
          error?: string;
        };
        if (!res.ok || body.ok === false) {
          toast.error(body.error ?? `Push failed (${res.status})`);
          return;
        }
        const r = body.run;
        const errCount = r?.errors.length ?? 0;
        const msg = `Inventory push complete — ${r?.pushed ?? 0} pushed, ${r?.skipped ?? 0} skipped${errCount > 0 ? `, ${errCount} errors` : ''}`;
        if (errCount > 0) toast.warning(msg);
        else toast.success(msg);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={onTest}
        disabled={!configured || busy}
      >
        <Plug />
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={onRegister}
        disabled={!configured || busy}
      >
        <Webhook />
        {registering ? 'Registering…' : 'Register webhooks'}
      </Button>
      <Button
        type="button"
        onClick={onFullSync}
        disabled={!configured || busy}
      >
        <RefreshCcw />
        {syncing ? 'Syncing — keep this tab open…' : 'Run full sync'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={onPushProducts}
        disabled={!configured || busy}
        title={
          !configured
            ? 'Configure store URL + secrets first'
            : 'Walks routing-rule matches and creates a Shopify listing for any product without one in this store'
        }
      >
        <ArrowUpFromLine />
        {pushingProducts
          ? 'Pushing products — keep this tab open (15+ min for large sets)…'
          : 'Push products'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={onPushAll}
        disabled={!pushEnabled || busy}
        title={
          !pushEnabled
            ? 'Enable inventory push + set a location id to use this'
            : undefined
        }
      >
        <Upload />
        {pushing ? 'Pushing — keep this tab open…' : 'Push all inventory'}
      </Button>
      <Button
        type="button"
        onClick={onSyncOrders}
        disabled={!orderSyncReady || busy}
        title={
          !orderSyncReady
            ? 'Enable order sync + set defaultWarehouse / salesRep / paymentTerm / customerType to use this'
            : 'Pulls orders updated since the last successful sync'
        }
      >
        <ArrowDownToLine />
        {syncingOrders
          ? 'Syncing orders — keep this tab open…'
          : 'Sync orders'}
      </Button>
    </div>
  );
}
