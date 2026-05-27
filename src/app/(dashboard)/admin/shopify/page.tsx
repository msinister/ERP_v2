import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listStores } from '@/server/services/shopifyStores';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateStoreButton } from './_components/create-store-dialog';

export const revalidate = 0;

export default async function ShopifyStoresPage() {
  const user = await getCurrentUser();
  if (!user?.isSuperAdmin) redirect('/dashboard');

  const stores = await listStores(db);

  // Live rule counts per store — small datasets, single round-trip.
  const ruleCounts = stores.length
    ? await db.shopifyStoreRule.groupBy({
        by: ['shopifyStoreId'],
        where: { shopifyStoreId: { in: stores.map((s) => s.id) } },
        _count: { _all: true },
      })
    : [];
  const ruleCountById = new Map(
    ruleCounts.map((r) => [r.shopifyStoreId, r._count._all]),
  );

  return (
    <div className="space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Admin
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Shopify stores
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect multiple Shopify stores. Each store has its own routing
            rules deciding which products sync into it, and an inventory-push
            toggle for ERP → Shopify quantity updates.
          </p>
        </div>
        <CreateStoreButton />
      </div>

      {stores.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No Shopify stores configured. Click <b>New store</b> to add one.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Store URL</TableHead>
                <TableHead>Sync</TableHead>
                <TableHead>Inventory push</TableHead>
                <TableHead className="text-right">Rules</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead>Last push</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/shopify/${s.id}`}
                      className="hover:underline"
                    >
                      {s.name}
                    </Link>
                    {!s.active ? (
                      <Badge
                        variant="outline"
                        className="ml-2 text-muted-foreground"
                      >
                        Inactive
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {s.storeUrl}
                  </TableCell>
                  <TableCell>
                    {s.syncEnabled ? (
                      <Badge variant="secondary">On</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Off
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.inventoryPushEnabled ? (
                      <Badge variant="secondary">On</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Off
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ruleCountById.get(s.id) ?? 0}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.lastProductSyncAt
                      ? formatDate(s.lastProductSyncAt)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.lastInventoryPushAt
                      ? formatDate(s.lastInventoryPushAt)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/shopify/${s.id}`}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Open store"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
