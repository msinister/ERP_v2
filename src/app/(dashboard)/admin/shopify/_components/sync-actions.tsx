'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plug, Webhook, RefreshCcw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

// Three buttons: test the connection, register webhooks, run a full sync.
// All three hit the new per-store admin routes. Slice A operates on the
// default store; Slice B will pass storeId explicitly per row.

export function ShopifySyncActions({
  storeId,
  configured,
}: {
  storeId: string;
  configured: boolean;
}) {
  const router = useRouter();
  const [testing, startTesting] = useTransition();
  const [registering, startRegistering] = useTransition();
  const [syncing, startSyncing] = useTransition();
  const [, setLastRunMarker] = useState(0);

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
        toast.success(
          `Connected — ${body.productCount ?? '?'} products in Shopify`,
        );
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
        setLastRunMarker(Date.now());
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
        disabled={!configured || testing || registering || syncing}
      >
        <Plug />
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={onRegister}
        disabled={!configured || testing || registering || syncing}
      >
        <Webhook />
        {registering ? 'Registering…' : 'Register webhooks'}
      </Button>
      <Button
        type="button"
        onClick={onFullSync}
        disabled={!configured || testing || registering || syncing}
      >
        <RefreshCcw />
        {syncing ? 'Syncing — keep this tab open…' : 'Run full sync'}
      </Button>
    </div>
  );
}
