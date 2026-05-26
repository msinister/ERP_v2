'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCcw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

// Re-pull this product from Shopify and re-run the upsert. Only rendered
// when the product has a primary ProductShopifyVariant junction row.

export function ShopifySyncButton({ productId }: { productId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/sync-product/${productId}`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          results?: Array<{ outcome: string; sku: string }>;
          error?: string;
        };
        if (!res.ok || body.ok === false) {
          toast.error(body.error ?? `Sync failed (${res.status})`);
          return;
        }
        const summary =
          body.results
            ?.map((r) => `${r.sku}: ${r.outcome}`)
            .join(', ') ?? 'done';
        toast.success(`Synced from Shopify — ${summary}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      <RefreshCcw />
      {pending ? 'Syncing…' : 'Sync from Shopify'}
    </Button>
  );
}
