import type { Product } from '@/generated/tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { TabShell } from './tab-shell';
import { TagEditor } from './tag-editor';
import {
  VendorEditor,
  type VendorOption,
  type PaymentTermOption,
} from './vendor-editor';

export function OverviewTab({
  product,
  tags,
  vendor,
  vendors,
  paymentTerms,
}: {
  product: Product & {
    shopifyVariants: Array<{
      id: string;
      shopifyProductId: string;
      isPrimary: boolean;
    }>;
  };
  tags: Array<{ id: string; name: string }>;
  vendor: { id: string; name: string } | null;
  vendors: VendorOption[];
  paymentTerms: PaymentTermOption[];
}) {
  return (
    <TabShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
            <Row label="Base price" value={
              product.basePrice != null ? formatCurrency(product.basePrice) : '—'
            } />
            <Row label="Tracks inventory" value={product.tracksInventory ? 'Yes' : 'No'} />
            <div className="space-y-0.5">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Vendor
              </dt>
              <dd className="text-sm">
                <VendorEditor
                  productId={product.id}
                  initialVendor={vendor}
                  vendors={vendors}
                  paymentTerms={paymentTerms}
                />
              </dd>
            </div>
            {product.shopifyVariants && product.shopifyVariants.length > 0 ? (
              <div className="space-y-0.5 md:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Shopify listings
                </dt>
                <dd className="space-y-1">
                  {product.shopifyVariants.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 text-sm font-mono">
                      <span>{v.shopifyProductId}</span>
                      <span className="text-xs text-muted-foreground">
                        {v.isPrimary ? '(primary)' : '(secondary)'}
                      </span>
                    </div>
                  ))}
                </dd>
              </div>
            ) : (
              <Row label="Shopify product ID" value="—" />
            )}
            <Row label="Last updated" value={formatDate(product.updatedAt)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tags</CardTitle>
        </CardHeader>
        <CardContent>
          <TagEditor productId={product.id} initialTags={tags} />
        </CardContent>
      </Card>

      {product.shortDescription || product.longDescription ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Description</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {product.shortDescription ? (
              <p className="text-sm font-medium">{product.shortDescription}</p>
            ) : null}
            {product.longDescription ? (
              <p className="whitespace-pre-line text-sm text-muted-foreground">
                {product.longDescription}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Dimensions &amp; weight</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
            <Row
              label="Weight"
              value={formatMeasure(product.weight, product.weightUnit)}
            />
            <Row
              label="Length"
              value={formatMeasure(product.lengthDim, product.dimensionUnit)}
            />
            <Row
              label="Width"
              value={formatMeasure(product.widthDim, product.dimensionUnit)}
            />
            <Row
              label="Height"
              value={formatMeasure(product.heightDim, product.dimensionUnit)}
            />
          </dl>
        </CardContent>
      </Card>
    </TabShell>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</dd>
    </div>
  );
}

function formatMeasure(
  d: { toString: () => string } | null,
  unit: string | null,
): string {
  if (d == null) return '—';
  const s = d.toString();
  const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return unit ? `${trimmed} ${unit}` : trimmed;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
