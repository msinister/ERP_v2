'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export type StoreEditFormInitial = {
  name: string;
  storeUrl: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  syncEnabled: boolean;
  inventoryPushEnabled: boolean;
  shopifyLocationId: string | null;
  active: boolean;
};

// Per-store connection settings form. Secrets are write-only: when one is
// already stored the input shows a placeholder instead of the cleartext
// value. Blank on save → keep stored value. Slice B replaces the legacy
// single-store form with this — same submit semantics, more fields.

export function StoreEditForm({
  storeId,
  initial,
}: {
  storeId: string;
  initial: StoreEditFormInitial;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(initial.name);
  const [storeUrl, setStoreUrl] = useState(initial.storeUrl);
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(initial.syncEnabled);
  const [inventoryPushEnabled, setInventoryPushEnabled] = useState(
    initial.inventoryPushEnabled,
  );
  const [shopifyLocationId, setShopifyLocationId] = useState(
    initial.shopifyLocationId ?? '',
  );
  const [active, setActive] = useState(initial.active);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const body: Record<string, unknown> = {
          name,
          storeUrl,
          syncEnabled,
          inventoryPushEnabled,
          active,
        };
        if (accessToken.trim()) body.accessToken = accessToken.trim();
        if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
        // Allow clearing the location id with an explicit empty string;
        // empty string in the form value means "clear" if the user wiped
        // an existing value (we send '' so the service nulls it).
        body.shopifyLocationId = shopifyLocationId.trim() || null;

        const res = await fetch(`/api/admin/shopify/stores/${storeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ path?: Array<string | number>; message?: string }>;
          };
          const issueMsg = err.issues?.[0]?.message;
          toast.error(issueMsg ?? err.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Store settings saved.');
        setAccessToken('');
        setWebhookSecret('');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="store-name">Display name</FieldLabel>
          <Input
            id="store-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="store-url">Store URL</FieldLabel>
          <Input
            id="store-url"
            placeholder="mystore.myshopify.com"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            autoComplete="off"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="store-access-token">API access token</FieldLabel>
          <Input
            id="store-access-token"
            type="password"
            placeholder={
              initial.hasAccessToken
                ? '••••••••  (stored — leave blank to keep)'
                : 'shpat_… (from the Shopify custom app)'
            }
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="store-webhook-secret">Webhook secret</FieldLabel>
          <Input
            id="store-webhook-secret"
            type="password"
            placeholder={
              initial.hasWebhookSecret
                ? '••••••••  (stored — leave blank to keep)'
                : 'webhook signing secret (HMAC)'
            }
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            autoComplete="off"
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="store-location-id">
          Shopify location id (inventory push target)
        </FieldLabel>
        <Input
          id="store-location-id"
          className="font-mono"
          placeholder="e.g. 95344590886"
          value={shopifyLocationId}
          onChange={(e) => setShopifyLocationId(e.target.value)}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Required for inventory push. Find it in Shopify Admin →
          Settings → Locations.
        </p>
      </Field>

      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={syncEnabled}
            onCheckedChange={(v) => setSyncEnabled(v === true)}
          />
          Sync enabled (webhooks process, full-sync allowed)
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={inventoryPushEnabled}
            onCheckedChange={(v) => setInventoryPushEnabled(v === true)}
          />
          Inventory push enabled
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={active}
            onCheckedChange={(v) => setActive(v === true)}
          />
          Active
        </label>
      </div>

      <div className="pt-1">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}
