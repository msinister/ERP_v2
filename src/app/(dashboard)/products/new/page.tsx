import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { ProductForm } from '../_components/product-form';

export const revalidate = 0;

export default function NewProductPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/products"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Products
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
          <p className="text-sm text-muted-foreground">
            Create the product record. After saving, add at least one variant
            from the product&apos;s Variants tab — variants own the SKU that
            sales orders and POs reference.
          </p>
        </div>
      </div>

      <ProductForm mode={{ kind: 'create' }} />
    </div>
  );
}
