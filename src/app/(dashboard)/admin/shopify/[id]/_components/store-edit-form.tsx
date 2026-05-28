'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type CustomerTypeValue =
  | 'WHOLESALE_REGULAR'
  | 'WHOLESALE_PREFERRED'
  | 'WHOLESALE_DISTRIBUTOR'
  | 'WHOLESALE_MASTER_DISTRIBUTOR'
  | 'RETAIL';

export type StoreEditFormInitial = {
  name: string;
  storeUrl: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  syncEnabled: boolean;
  inventoryPushEnabled: boolean;
  orderSyncEnabled: boolean;
  shopifyLocationId: string | null;
  defaultWarehouseId: string | null;
  defaultSalesRepId: string | null;
  defaultPaymentTermId: string | null;
  defaultCustomerType: CustomerTypeValue | null;
  active: boolean;
};

export type StoreEditOptions = {
  warehouses: Array<{ id: string; code: string; name: string }>;
  salesReps: Array<{ id: string; code: string; name: string }>;
  paymentTerms: Array<{ id: string; code: string; label: string }>;
};

const CUSTOMER_TYPE_OPTIONS: Array<{ value: CustomerTypeValue; label: string }> = [
  { value: 'RETAIL', label: 'Retail (B2C — auto-invoice + payment as EXTERNAL)' },
  { value: 'WHOLESALE_REGULAR', label: 'Wholesale Regular' },
  { value: 'WHOLESALE_PREFERRED', label: 'Wholesale Preferred' },
  { value: 'WHOLESALE_DISTRIBUTOR', label: 'Wholesale Distributor' },
  { value: 'WHOLESALE_MASTER_DISTRIBUTOR', label: 'Wholesale Master Distributor' },
];

const UNSET = '__unset__';

// Per-store connection settings form. Secrets are write-only: when one is
// already stored the input shows a placeholder instead of the cleartext
// value. Blank on save → keep stored value. The order-sync defaults
// (warehouse / sales rep / payment term / customer type) are required
// for order import; the form lets you save them piecemeal but the
// "Sync Orders" button stays disabled until every one is set.

export function StoreEditForm({
  storeId,
  initial,
  options,
}: {
  storeId: string;
  initial: StoreEditFormInitial;
  options: StoreEditOptions;
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
  const [orderSyncEnabled, setOrderSyncEnabled] = useState(
    initial.orderSyncEnabled,
  );
  const [shopifyLocationId, setShopifyLocationId] = useState(
    initial.shopifyLocationId ?? '',
  );
  const [defaultWarehouseId, setDefaultWarehouseId] = useState<string>(
    initial.defaultWarehouseId ?? UNSET,
  );
  const [defaultSalesRepId, setDefaultSalesRepId] = useState<string>(
    initial.defaultSalesRepId ?? UNSET,
  );
  const [defaultPaymentTermId, setDefaultPaymentTermId] = useState<string>(
    initial.defaultPaymentTermId ?? UNSET,
  );
  const [defaultCustomerType, setDefaultCustomerType] = useState<string>(
    initial.defaultCustomerType ?? UNSET,
  );
  const [active, setActive] = useState(initial.active);

  function valueOrNull(v: string): string | null {
    return v === UNSET || v === '' ? null : v;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const body: Record<string, unknown> = {
          name,
          storeUrl,
          syncEnabled,
          inventoryPushEnabled,
          orderSyncEnabled,
          active,
        };
        if (accessToken.trim()) body.accessToken = accessToken.trim();
        if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
        body.shopifyLocationId = shopifyLocationId.trim() || null;
        body.defaultWarehouseId = valueOrNull(defaultWarehouseId);
        body.defaultSalesRepId = valueOrNull(defaultSalesRepId);
        body.defaultPaymentTermId = valueOrNull(defaultPaymentTermId);
        body.defaultCustomerType = valueOrNull(defaultCustomerType);

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

      <div className="space-y-3 rounded-md border border-dashed p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Order import defaults
        </div>
        <p className="text-xs text-muted-foreground">
          Required before &ldquo;Sync orders&rdquo; / order webhooks can import.
          Auto-created customers + sales orders inherit these.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="store-default-warehouse">Default warehouse</FieldLabel>
            <Select
              value={defaultWarehouseId}
              onValueChange={(v) => setDefaultWarehouseId(v ?? UNSET)}
            >
              <SelectTrigger id="store-default-warehouse">
                <SelectValue placeholder="Select warehouse…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>— Not set —</SelectItem>
                {options.warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="store-default-rep">Default sales rep</FieldLabel>
            <Select
              value={defaultSalesRepId}
              onValueChange={(v) => setDefaultSalesRepId(v ?? UNSET)}
            >
              <SelectTrigger id="store-default-rep">
                <SelectValue placeholder="Select sales rep…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>— Not set —</SelectItem>
                {options.salesReps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.code} · {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="store-default-terms">Default payment terms</FieldLabel>
            <Select
              value={defaultPaymentTermId}
              onValueChange={(v) => setDefaultPaymentTermId(v ?? UNSET)}
            >
              <SelectTrigger id="store-default-terms">
                <SelectValue placeholder="Select payment terms…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>— Not set —</SelectItem>
                {options.paymentTerms.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.code} · {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="store-default-type">Default customer type</FieldLabel>
            <Select
              value={defaultCustomerType}
              onValueChange={(v) => setDefaultCustomerType(v ?? UNSET)}
            >
              <SelectTrigger id="store-default-type">
                <SelectValue placeholder="Select customer type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>— Not set —</SelectItem>
                {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={syncEnabled}
            onCheckedChange={(v) => setSyncEnabled(v === true)}
          />
          Product sync enabled (webhooks process, full-sync allowed)
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
            checked={orderSyncEnabled}
            onCheckedChange={(v) => setOrderSyncEnabled(v === true)}
          />
          Order sync enabled (Shopify → ERP order import + webhooks)
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
