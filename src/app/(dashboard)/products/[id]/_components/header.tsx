import Link from 'next/link';
import { MoreVertical, Pencil, Wrench } from 'lucide-react';
import type { Product } from '@/generated/tenant';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArchiveProductAction } from './archive-action';

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
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="More actions"
                  />
                }
              >
                <MoreVertical />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ArchiveProductAction
                  productId={product.id}
                  productName={product.name}
                />
              </DropdownMenuContent>
            </DropdownMenu>
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
