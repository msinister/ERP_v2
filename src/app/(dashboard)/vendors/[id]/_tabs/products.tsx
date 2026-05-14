import { db } from '@/lib/db';
import type { Vendor } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listVendorProducts } from '@/server/services/vendorProducts';
import { formatCurrency } from '@/lib/format';
import { TabShell, TabEmpty } from './tab-shell';
import { AddProductButton } from '../_components/add-product-button';
import { ProductRowActions } from '../_components/product-row-actions';
import type { VariantOption } from '../_components/product-form-dialog';

export async function ProductsTab({ vendor }: { vendor: Vendor }) {
  // SERVICE-type vendors are blocked from catalog rows at the service
  // layer (docs/04 line 7). Surface that as a tab-level message rather
  // than letting the user hit a 400 from the form.
  if (vendor.type === 'SERVICE') {
    return (
      <TabShell>
        <TabEmpty message="Service vendors are AP-only — no product catalog per spec." />
      </TabShell>
    );
  }

  const [products, variants] = await Promise.all([
    listVendorProducts(db, vendor.id),
    // Pilot scale: a few dozen variants. Fetch all active in one go so
    // the picker doesn't need an API search.
    db.productVariant.findMany({
      where: {
        active: true,
        deletedAt: null,
        product: { active: true, deletedAt: null },
      },
      include: { product: { select: { name: true } } },
      orderBy: { sku: 'asc' },
      take: 1000,
    }),
  ]);

  // Variant metadata keyed by id so the row labels resolve without an
  // N+1 inside the table.
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const variantOptions: VariantOption[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    variantName: v.name,
    productName: v.product.name,
  }));
  const existingVariantIds = new Set(products.map((p) => p.variantId));

  if (products.length === 0) {
    return (
      <TabShell>
        <TabEmpty
          message="No catalog rows on file."
          action={
            <AddProductButton
              vendorId={vendor.id}
              variants={variantOptions}
              existingVariantIds={existingVariantIds}
            />
          }
        />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="flex justify-end">
        <AddProductButton
          vendorId={vendor.id}
          variants={variantOptions}
          existingVariantIds={existingVariantIds}
        />
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>SKU</TableHead>
              <TableHead>Product / variant</TableHead>
              <TableHead>Vendor SKU</TableHead>
              <TableHead className="text-right">Latest cost</TableHead>
              <TableHead className="text-right">Pack</TableHead>
              <TableHead className="w-24">Primary</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => {
              const v = variantById.get(p.variantId);
              const variantLabel = v
                ? `${v.sku} — ${v.product.name}${
                    v.name ? ` · ${v.name}` : ''
                  }`
                : `(unknown variant ${p.variantId.slice(0, 6)}…)`;
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">
                    {v?.sku ?? '—'}
                  </TableCell>
                  <TableCell>
                    {v ? (
                      <div className="flex flex-col text-sm leading-tight">
                        <span className="font-medium">{v.product.name}</span>
                        {v.name ? (
                          <span className="text-xs text-muted-foreground">
                            {v.name}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {p.vendorSku ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.latestCost ? formatCurrency(p.latestCost) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.packSize ? p.packSize.toString() : '—'}
                  </TableCell>
                  <TableCell>
                    {p.isPrimary ? (
                      <Badge variant="secondary">Primary</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {p.active ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <ProductRowActions
                      vendorId={vendor.id}
                      variants={variantOptions}
                      existingVariantIds={existingVariantIds}
                      product={{
                        id: p.id,
                        variantId: p.variantId,
                        variantLabel,
                        vendorSku: p.vendorSku,
                        latestCost: p.latestCost?.toString() ?? null,
                        packSize: p.packSize?.toString() ?? null,
                        isPrimary: p.isPrimary,
                        active: p.active,
                        notes: p.notes,
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}
