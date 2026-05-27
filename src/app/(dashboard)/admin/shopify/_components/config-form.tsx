'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export type ShopifyConfigFormInitial = {
  name: string;
  storeUrl: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  syncEnabled: boolean;
};

// Inline form for one ShopifyStore. Secrets are write-only — when a token /
// webhook secret is already stored the input shows a placeholder instead of
// the cleartext value (we'd never ship secrets back to the browser).
// Leaving the input blank on save means "keep the stored value".
//
// Slice A: operates on the single default store. Slice B replaces with a
// per-store editor.

export function ShopifyConfigForm({
  storeId,
  initial,
}: {
  storeId: string;
  initial: ShopifyConfigFormInitial;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initial.name);
  const [storeUrl, setStoreUrl] = useState(initial.storeUrl);
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(initial.syncEnabled);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const body: Record<string, unknown> = {
          name,
          storeUrl,
          syncEnabled,
        };
        if (accessToken.trim()) body.accessToken = accessToken.trim();
        if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
        const res = await fetch(`/api/admin/shopify/stores/${storeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(err.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Shopify settings saved');
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
      <Field>
        <FieldLabel htmlFor="shopify-store-name">Display name</FieldLabel>
        <Input
          id="shopify-store-name"
          placeholder="My Shopify store"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="shopify-store-url">Store URL</FieldLabel>
        <Input
          id="shopify-store-url"
          placeholder="mystore.myshopify.com"
          value={storeUrl}
          onChange={(e) => setStoreUrl(e.target.value)}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          The bare *.myshopify.com host. No https://, no path.
        </p>
      </Field>

      <Field>
        <FieldLabel htmlFor="shopify-access-token">
          API access token
        </FieldLabel>
        <Input
          id="shopify-access-token"
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
        <FieldLabel htmlFor="shopify-webhook-secret">
          Webhook secret
        </FieldLabel>
        <Input
          id="shopify-webhook-secret"
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
        <p className="text-xs text-muted-foreground">
          Used to verify the <code>X-Shopify-Hmac-Sha256</code> header on
          every incoming webhook.
        </p>
      </Field>

      <div className="flex items-center gap-2">
        <Checkbox
          id="shopify-sync-enabled"
          checked={syncEnabled}
          onCheckedChange={(v) => setSyncEnabled(v === true)}
        />
        <label
          htmlFor="shopify-sync-enabled"
          className="cursor-pointer text-sm"
        >
          Sync enabled — incoming webhooks process, full-sync allowed
        </label>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  );
}
