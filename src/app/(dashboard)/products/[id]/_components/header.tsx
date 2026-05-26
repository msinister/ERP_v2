import Link from 'next/link';
import { Pencil, ShoppingBag, Wrench } from 'lucide-react';
import type { Product } from '@/generated/tenant';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArchiveProductAction } from './archive-action';
import { ShopifySyncButton } from './shopify-sync-button';

export function ProductHeader({
  product,
  hasBom = false,
}: {
  product: Product;
  hasBom?: boolean;
}) {
  const archived = product.deletedAt != null;
  const status: 'active' | 'inactive' | 'archived' = archived
    ? 'archived'
    : product.active
      ? 'active'
      : 'inactive';
  const bomEligible = product.type === 'SIMPLE' || product.type === 'ASSEMBLED';
  // Build action surfaces only when the product has a BOM defined —
  // /work-orders/new short-circuits without one anyway, but no point
  // dangling a dead button.
  const showBuild = !archived && bomEligible && hasBom;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {product.name}
            </h1>
            <StatusBadge status={status} />
            {product.shopifyProductId ? (
              <Badge
                variant="outline"
                title={
                  product.shopifySyncedAt
                    ? `Last synced ${product.shopifySyncedAt.toLocaleString()}`
                    : 'Synced from Shopify'
                }
                className="gap-1 text-[10px] font-normal text-muted-foreground"
              >
                <ShoppingBag className="size-3" />
                Synced from Shopify
                {product.shopifySyncedAt ? (
                  <span className="ml-1 text-muted-foreground/70">
                    · {formatRelative(product.shopifySyncedAt)}
                  </span>
                ) : null}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{product.sku}</span>
            {product.brand ? (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span>{product.brand}</span>
              </>
            ) : null}
            {product.category ? (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span>{product.category}</span>
              </>
            ) : null}
            <span className="text-muted-foreground/50">·</span>
            <span>{formatType(product.type)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showBuild ? (
            <Button
              size="sm"
              render={
                <Link href={`/work-orders/new?productId=${product.id}`} />
              }
            >
              <Wrench />
              Build
            </Button>
          ) : null}
          {!archived && product.shopifyProductId ? (
            <ShopifySyncButton productId={product.id} />
          ) : null}
          {!archived ? (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/products/${product.id}/edit`} />}
            >
              <Pencil />
              Edit
            </Button>
          ) : null}
          {!archived ? (
            <ArchiveProductAction
              productId={product.id}
              productName={product.name}
            />
          ) : null}
        </div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'active' | 'inactive' | 'archived';
}) {
  switch (status) {
    case 'active':
      return <Badge variant="secondary">Active</Badge>;
    case 'inactive':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Inactive
        </Badge>
      );
    case 'archived':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Archived
        </Badge>
      );
  }
}

function formatType(t: string): string {
  switch (t) {
    case 'SIMPLE':
      return 'Simple';
    case 'ASSEMBLED':
      return 'Assembled';
    case 'BUNDLE':
      return 'Bundle';
    case 'DROP_SHIP':
      return 'Drop-ship';
    case 'SERVICE':
      return 'Service';
    default:
      return t;
  }
}

// "5m ago" / "2h ago" / "Mar 12" — coarse and read-at-a-glance. The full
// timestamp is in the badge's title attribute for the operator who needs
// it.
function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
