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
import type {
  MatchedCustomerEnrichment,
  PendingReviewListItem,
} from '@/server/services/pendingOrderReviews';

// Side-by-side review card. On the left: Shopify order data extracted
// from the parked payload. On the right: the candidate ERP customer
// when one was matched (email match with a different shopifyCustomerId,
// or operator's chosen customer for a multiple-email-match scenario).
//
// For UNKNOWN_SKU reviews there's no customer to compare; the card
// just shows the Shopify side + the offending SKU and offers Dismiss
// (the only real recourse is to create the missing product upstream
// and re-run the sync — there's no "fix here" path yet).

type ReviewWithEnrichment = PendingReviewListItem & {
  matchedCustomerEnrichment: MatchedCustomerEnrichment | null;
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
              value={
                fullName(order.customer?.first_name, order.customer?.last_name) ||
                fullName(
                  order.billing_address?.first_name,
                  order.billing_address?.last_name,
                ) ||
                '—'
              }
            />
            <KV label="Email" value={order.email ?? order.customer?.email ?? '—'} />
            <KV
              label="Phone"
              value={order.customer?.phone ?? order.phone ?? '—'}
            />
            <KV
              label="Shopify customer id"
              value={order.customer?.id ?? '—'}
              mono
            />
            <KV
              label="Billing"
              value={formatAddress(order.billing_address)}
            />
            <KV
              label="Shipping"
              value={formatAddress(order.shipping_address)}
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
              title={`ERP customer — ${matched.name}`}
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
              <KV label="Name" value={matched.name} />
              <KV label="Email" value={matched.primaryEmail ?? '—'} />
              <KV label="Phone" value={matched.primaryPhone ?? '—'} />
              <KV
                label="Shopify customer id"
                value={matched.shopifyCustomerId ?? '— (not linked yet)'}
                mono
              />
              {enrichment ? (
                <>
                  <KV
                    label="Orders"
                    value={`${enrichment.orderCount}`}
                  />
                  <KV
                    label="Lifetime revenue"
                    value={fmtMoney(enrichment.lifetimeRevenue, 'USD')}
                  />
                  <KV
                    label="Open AR"
                    value={fmtMoney(enrichment.openArBalance, 'USD')}
                  />
                  <KV
                    label="Addresses"
                    value={`${enrichment.addressCount}`}
                  />
                </>
              ) : null}
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
                  Use existing customer
                </Button>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={addAsNewAddress}
                    onCheckedChange={(v) => setAddAsNewAddress(v === true)}
                  />
                  Also add Shopify ship-to as a new address
                </label>
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
  extra,
}: {
  label: string;
  value: string;
  mono?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <span className={mono ? 'font-mono' : ''}>{value}</span>
        {extra}
      </dd>
    </div>
  );
}

function fullName(a: string | null | undefined, b: string | null | undefined) {
  return [a, b].filter(Boolean).join(' ').trim();
}

function formatAddress(a: ShopifyAddressShape | null): string {
  if (!a) return '—';
  const parts = [
    a.address1,
    a.address2,
    [a.city, a.province_code ?? a.province, a.zip].filter(Boolean).join(' '),
    a.country_code ?? a.country,
  ].filter((s): s is string => !!s && s.trim() !== '');
  return parts.join(', ') || '—';
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
