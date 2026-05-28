'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Check, ExternalLink, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type {
  MatchedCustomerAddress,
  MatchedCustomerEnrichment,
  PendingReviewListItem,
} from '@/server/services/pendingOrderReviews';

// Side-by-side review card. On the left: Shopify order data extracted
// from the parked payload. On the right: the candidate ERP customer
// when one was matched (email match with a conflicting store-scoped link,
// or operator's chosen customer for a multiple-email-match scenario).
//
// For UNKNOWN_SKU reviews there's no customer to compare; the card
// just shows the Shopify side + the offending SKU and offers Dismiss
// (the only real recourse is to create the missing product upstream
// and re-run the sync — there's no "fix here" path yet).

type ReviewWithEnrichment = PendingReviewListItem & {
  matchedCustomerEnrichment: MatchedCustomerEnrichment | null;
  linkedCustomerOverride?: boolean;
};

type ShopifyOrderShape = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  currency: string;
  financial_status: string | null;
  total_price: string;
  customer: {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  } | null;
  billing_address: ShopifyAddressShape | null;
  shipping_address: ShopifyAddressShape | null;
  line_items: Array<{
    id: string;
    sku: string | null;
    title: string;
    variant_title: string | null;
    quantity: number;
    price: string;
  }>;
};

type ShopifyAddressShape = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  province_code: string | null;
  zip: string | null;
  country: string | null;
  country_code: string | null;
  phone: string | null;
};

export function ReviewCard({
  review,
  readOnly,
}: {
  review: ReviewWithEnrichment;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [addAsNewAddress, setAddAsNewAddress] = useState(false);

  const order = review.shopifyOrderData as unknown as ShopifyOrderShape;
  const matched = review.matchedCustomer;
  const enrichment = review.matchedCustomerEnrichment;
  const showCompare = matched != null;
  const linkedOverride = review.linkedCustomerOverride ?? false;

  // ---------------------------------------------------------------------------
  // Field-match detection. Computed once per render so both sides of the
  // compare can highlight together. Email/phone use normalized exact match;
  // address match keys (street+city+region+zip) are kept as a Set so the
  // ERP address list can highlight each row individually against either the
  // Shopify billing OR shipping address.
  // ---------------------------------------------------------------------------
  const shopifyEmail = (order.customer?.email ?? order.email ?? '')
    .toLowerCase()
    .trim();
  const erpEmail = (matched?.primaryEmail ?? '').toLowerCase().trim();
  const emailMatches = !!shopifyEmail && shopifyEmail === erpEmail;

  const shopifyPhoneDigits = digits(order.customer?.phone ?? order.phone);
  const erpPhoneDigits = digits(matched?.primaryPhone);
  // Require ≥ 7 digits so a partial / extension number doesn't trigger a
  // false positive against an unrelated short number.
  const phoneMatches =
    shopifyPhoneDigits.length >= 7 && shopifyPhoneDigits === erpPhoneDigits;

  const shopifyName =
    fullName(order.customer?.first_name, order.customer?.last_name) ||
    fullName(
      order.billing_address?.first_name,
      order.billing_address?.last_name,
    );
  const nameMatches = compareName(shopifyName, matched?.name ?? '');

  const erpAddrKeySet = new Set(
    (matched?.addresses ?? [])
      .map((a) => erpAddressKey(a))
      .filter((k): k is string => k != null),
  );
  const shopifyBillingKey = shopifyAddressKey(order.billing_address);
  const shopifyShippingKey = shopifyAddressKey(order.shipping_address);
  const billingMatches =
    shopifyBillingKey != null && erpAddrKeySet.has(shopifyBillingKey);
  const shippingMatches =
    shopifyShippingKey != null && erpAddrKeySet.has(shopifyShippingKey);

  function call(action: object, successMsg: string) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/pending-orders/${review.id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: {
            outcome: string;
            salesOrderId?: string;
            pendingReviewId?: string;
            reason?: string;
          };
          error?: string;
        };
        if (!res.ok || body.ok === false) {
          toast.error(body.error ?? `Resolve failed (${res.status})`);
          return;
        }
        if (body.result?.outcome === 'pending_review') {
          toast.warning(
            `Still pending — reason: ${body.result.reason ?? 'unknown'}`,
          );
        } else {
          toast.success(successMsg);
        }
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Network error');
      }
    });
  }

  function onUseExisting() {
    if (!matched) return;
    call(
      {
        action: 'use_existing',
        customerId: matched.id,
        addAsNewAddress,
      },
      `Imported under ${matched.name}`,
    );
  }
  function onCreateNew() {
    call({ action: 'create_new' }, 'Imported under a new customer');
  }
  function onDismiss() {
    call({ action: 'dismiss' }, 'Review dismissed');
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{order.name}</span>
            <Badge variant="outline" className="text-xs">
              {review.store.name}
            </Badge>
            <ReasonBadge reason={review.reason} />
            {review.status !== 'PENDING' ? (
              <Badge variant="secondary">{review.status}</Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {fmtMoney(order.total_price, order.currency)} ·{' '}
            {review.shopifyCustomerEmail || '(no email)'} ·{' '}
            {new Date(review.createdAt).toLocaleString()}
          </div>
        </div>
        {review.resolvedSalesOrderId ? (
          <Link
            href={`/sales-orders/${review.resolvedSalesOrderId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open SO
            <ExternalLink className="size-3" />
          </Link>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {review.reason === 'UNKNOWN_SKU' ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="size-3.5" />
              Unknown SKU
            </div>
            <p className="text-muted-foreground">
              <span className="font-mono text-foreground">
                {review.unknownSku ?? '(blank)'}
              </span>{' '}
              has no matching active ProductVariant in the ERP. Create
              the product in /products and re-run order sync; or dismiss
              if it&apos;s a Shopify-only item that shouldn&apos;t import.
            </p>
          </div>
        ) : null}

        <div
          className={
            showCompare
              ? 'grid gap-4 lg:grid-cols-2'
              : 'grid gap-4'
          }
        >
          <ComparePanel title="Shopify order">
            <KV
              label="Name"
              value={shopifyName || '—'}
              match={showCompare && nameMatches}
            />
            <KV
              label="Email"
              value={order.email ?? order.customer?.email ?? '—'}
              match={showCompare && emailMatches}
            />
            <KV
              label="Phone"
              value={order.customer?.phone ?? order.phone ?? '—'}
              match={showCompare && phoneMatches}
            />
            <KV
              label="Shopify customer id"
              value={order.customer?.id ?? '—'}
              mono
            />
            <KV
              label="Billing"
              value={formatShopifyAddress(order.billing_address)}
              match={showCompare && billingMatches}
            />
            <KV
              label="Shipping"
              value={formatShopifyAddress(order.shipping_address)}
              match={showCompare && shippingMatches}
            />
            <KV
              label="Items"
              value={`${order.line_items.length} line(s)`}
              extra={
                <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                  {order.line_items.map((li) => (
                    <li key={li.id}>
                      <span className="font-mono">{li.sku ?? '(no sku)'}</span>{' '}
                      × {li.quantity} — {li.title}
                      {li.variant_title ? ` · ${li.variant_title}` : ''}
                    </li>
                  ))}
                </ul>
              }
            />
          </ComparePanel>

          {matched ? (
            <ComparePanel
              title={
                linkedOverride
                  ? `ERP customer (already linked) — ${matched.name}`
                  : `ERP customer — ${matched.name}`
              }
              cta={
                <Link
                  href={`/customers/${matched.id}`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Open
                  <ExternalLink className="size-3" />
                </Link>
              }
            >
              <KV label="Name" value={matched.name} match={nameMatches} />
              <KV
                label="Email"
                value={matched.primaryEmail ?? '—'}
                match={emailMatches}
              />
              <KV
                label="Phone"
                value={matched.primaryPhone ?? '—'}
                match={phoneMatches}
              />
              {enrichment ? (
                <>
                  <KV label="Orders" value={`${enrichment.orderCount}`} />
                  <KV
                    label="Lifetime revenue"
                    value={fmtMoney(enrichment.lifetimeRevenue, 'USD')}
                  />
                  <KV
                    label="Open AR"
                    value={fmtMoney(enrichment.openArBalance, 'USD')}
                  />
                </>
              ) : null}
              <AddressList
                addresses={matched.addresses}
                billingMatchKey={billingMatches ? shopifyBillingKey : null}
                shippingMatchKey={shippingMatches ? shopifyShippingKey : null}
              />
            </ComparePanel>
          ) : null}
        </div>

        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {matched ? (
              <>
                <Button
                  type="button"
                  onClick={onUseExisting}
                  disabled={pending}
                >
                  <Check />
                  {linkedOverride ? 'Import under linked customer' : 'Use existing customer'}
                </Button>
                {linkedOverride ? (
                  <span className="text-xs text-muted-foreground">
                    A previous order already linked this Shopify account to{' '}
                    <strong>{matched.name}</strong>.
                  </span>
                ) : (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={addAsNewAddress}
                      onCheckedChange={(v) => setAddAsNewAddress(v === true)}
                    />
                    Also add Shopify ship-to as a new address
                  </label>
                )}
              </>
            ) : null}
            {review.reason !== 'UNKNOWN_SKU' ? (
              <Button
                type="button"
                variant="secondary"
                onClick={onCreateNew}
                disabled={pending}
              >
                Create new customer
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={onDismiss}
              disabled={pending}
            >
              <X />
              Dismiss
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReasonBadge({ reason }: { reason: string }) {
  const label =
    reason === 'EMAIL_MATCH_DIFFERENT_ID'
      ? 'Email matches a different Shopify id'
      : reason === 'MULTIPLE_EMAIL_MATCHES'
        ? 'Email matches multiple customers'
        : reason === 'EMAIL_MATCH_NO_STORE_LINK'
          ? 'New Shopify customer — confirm or create billing account'
          : reason === 'UNKNOWN_SKU'
            ? 'Unknown SKU'
            : reason;
  return (
    <Badge variant="outline" className="text-xs">
      {label}
    </Badge>
  );
}

function ComparePanel({
  title,
  cta,
  children,
}: {
  title: string;
  cta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        {cta}
      </div>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  match,
  extra,
}: {
  label: string;
  value: string;
  mono?: boolean;
  match?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[7rem_1fr] gap-2 rounded-sm py-0.5 text-xs',
        // Soft green when this field matches its counterpart on the other
        // side. Tailwind's emerald scale renders on both light + dark.
        match &&
          'bg-emerald-50 px-1.5 dark:bg-emerald-950/40',
      )}
    >
      <dt className={cn('text-muted-foreground', match && 'text-emerald-800 dark:text-emerald-200')}>
        {label}
      </dt>
      <dd className={cn(match && 'text-emerald-900 dark:text-emerald-100')}>
        <span className={mono ? 'font-mono' : ''}>{value}</span>
        {extra}
      </dd>
    </div>
  );
}

// Render all ERP customer addresses inline (replaces the prior single
// "Addresses: N" count). Each row gets a green highlight when its
// normalized key matches the Shopify billing or shipping address key —
// the same color treatment as the KV match prop, so the operator can
// scan and see what lines up.
function AddressList({
  addresses,
  billingMatchKey,
  shippingMatchKey,
}: {
  addresses: MatchedCustomerAddress[];
  billingMatchKey: string | null;
  shippingMatchKey: string | null;
}) {
  if (addresses.length === 0) {
    return (
      <div className="grid grid-cols-[7rem_1fr] gap-2 text-xs">
        <dt className="text-muted-foreground">Addresses</dt>
        <dd className="text-muted-foreground">No addresses on file</dd>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-xs">
      <dt className="text-muted-foreground">
        Addresses
        <span className="ml-1 text-muted-foreground/60">
          ({addresses.length})
        </span>
      </dt>
      <dd className="space-y-1">
        {addresses.map((a) => {
          const key = erpAddressKey(a);
          const matches =
            key != null &&
            ((billingMatchKey != null && key === billingMatchKey) ||
              (shippingMatchKey != null && key === shippingMatchKey));
          return (
            <div
              key={a.id}
              className={cn(
                'rounded-sm py-0.5 leading-snug',
                matches &&
                  'bg-emerald-50 px-1.5 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
              )}
            >
              <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {a.kind === 'BILLING' ? 'Bill' : 'Ship'}
                {a.isDefault ? '·default' : ''}
              </span>
              <span>{formatErpAddress(a)}</span>
              {a.label ? (
                <span className="ml-1 text-muted-foreground">
                  ({a.label})
                </span>
              ) : null}
            </div>
          );
        })}
      </dd>
    </div>
  );
}

function fullName(a: string | null | undefined, b: string | null | undefined) {
  return [a, b].filter(Boolean).join(' ').trim();
}

function formatShopifyAddress(a: ShopifyAddressShape | null): string {
  if (!a) return '—';
  const parts = [
    a.address1,
    a.address2,
    [a.city, a.province_code ?? a.province, a.zip].filter(Boolean).join(' '),
    a.country_code ?? a.country,
  ].filter((s): s is string => !!s && s.trim() !== '');
  return parts.join(', ') || '—';
}

function formatErpAddress(a: MatchedCustomerAddress): string {
  const parts = [
    a.line1,
    a.line2,
    [a.city, a.region, a.postalCode].filter(Boolean).join(' '),
    a.country,
  ].filter((s): s is string => !!s && s.trim() !== '');
  return parts.join(', ') || '—';
}

// Normalize a phone string to digits-only. Empty input → empty string;
// callers gate on length to skip trivially-short matches.
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

// Loose name comparison — case-insensitive equality OR one string
// containing the other after normalization. The looser containment
// branch catches "John Smith" vs "John Smith (Acme)" patterns common
// when the ERP display name appends a city / company suffix per
// docs/03-customers.md.
function compareName(a: string, b: string): boolean {
  const sa = a.toLowerCase().trim();
  const sb = b.toLowerCase().trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  // Avoid matches where one side is too short to be meaningful (e.g.
  // last-name only colliding with a longer display name).
  if (sa.length < 3 || sb.length < 3) return false;
  return sa.includes(sb) || sb.includes(sa);
}

// Build a normalized key for ERP-side address comparison. Returns null
// when either street or zip is missing — those are the load-bearing
// fields; a "city only" match isn't useful.
function erpAddressKey(a: MatchedCustomerAddress): string | null {
  const line1 = a.line1.toLowerCase().replace(/\s+/g, ' ').trim();
  const zip = a.postalCode.toLowerCase().trim();
  if (!line1 || !zip) return null;
  return [
    line1,
    a.city.toLowerCase().trim(),
    a.region.toLowerCase().trim(),
    zip,
  ].join('|');
}

// Same shape from the Shopify side. Tolerates a missing province_code
// by falling back to province (full name).
function shopifyAddressKey(a: ShopifyAddressShape | null): string | null {
  if (!a) return null;
  const line1 = (a.address1 ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const zip = (a.zip ?? '').toLowerCase().trim();
  if (!line1 || !zip) return null;
  return [
    line1,
    (a.city ?? '').toLowerCase().trim(),
    (a.province_code ?? a.province ?? '').toLowerCase().trim(),
    zip,
  ].join('|');
}

function fmtMoney(s: string, currency: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
