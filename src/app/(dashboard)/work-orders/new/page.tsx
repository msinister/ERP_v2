import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { listWarehouses } from '@/server/services/warehouse';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NewWorkOrderForm } from './_components/new-form';

export const revalidate = 0;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

// /work-orders/new?productId=...  is the canonical entry point — the
// "Build" button on the product detail page deep-links here with the
// product pre-selected. The form locks the product (one BOM = one
// finished product) and lets the operator pick the variant, warehouse,
// qty, and labor override.
export default async function NewWorkOrderPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const productId = pickString(sp.productId);
  if (!productId) {
    // No product → bounce back to the list. The Build button is the
    // intended entry point; this is just a safety net.
    redirect('/work-orders');
  }

  const product = await db.product.findFirst({
    where: { id: productId, deletedAt: null },
    include: {
      variants: {
        where: { deletedAt: null, active: true },
        orderBy: { sku: 'asc' },
      },
      bomLines: {
        where: { deletedAt: null },
        include: {
          componentVariant: {
            select: {
              id: true,
              sku: true,
              name: true,
              product: { select: { name: true } },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  if (!product) notFound();

  const bomEligible =
    product.type === 'SIMPLE' || product.type === 'ASSEMBLED';
  if (!bomEligible || product.bomLines.length === 0) {
    return (
      <div className="space-y-6">
        <Link
          href={`/products/${product.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {product.name}
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cannot build this product</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {!bomEligible
                ? 'Only Simple and Assembled products can be built.'
                : 'This product has no BOM defined yet. Add components on the BOM tab first.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`/products/${product.id}`} />}
            >
              Back to product
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const warehouses = await listWarehouses(db);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href={`/products/${product.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {product.name}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            New work order
          </h1>
          <p className="text-sm text-muted-foreground">
            Snapshots the BOM at create time. Start the build to begin
            consuming components.
          </p>
        </div>
      </div>

      <NewWorkOrderForm
        product={{
          id: product.id,
          sku: product.sku,
          name: product.name,
          bomLaborCost: product.bomLaborCost?.toString() ?? null,
        }}
        variants={product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
        }))}
        warehouses={warehouses.map((w) => ({
          id: w.id,
          code: w.code,
          name: w.name,
        }))}
        bomLines={product.bomLines.map((l) => ({
          componentVariantSku: l.componentVariant.sku,
          componentProductName: l.componentVariant.product.name,
          componentVariantName: l.componentVariant.name,
          qtyRequiredPerUnit: l.qtyRequired.toString(),
        }))}
      />
    </div>
  );
}
