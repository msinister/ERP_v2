import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import {
  ProductForm,
  type ProductFormValues,
} from '../../_components/product-form';

export const revalidate = 0;

type WeightUnit = ProductFormValues['weightUnit'];
type DimensionUnit = ProductFormValues['dimensionUnit'];

const WEIGHT_UNITS: WeightUnit[] = ['oz', 'lb', 'kg', 'g'];
const DIMENSION_UNITS: DimensionUnit[] = ['in', 'mm', 'cm'];

function asWeightUnit(v: string | null): WeightUnit {
  return v != null && (WEIGHT_UNITS as string[]).includes(v)
    ? (v as WeightUnit)
    : 'lb';
}
function asDimensionUnit(v: string | null): DimensionUnit {
  return v != null && (DIMENSION_UNITS as string[]).includes(v)
    ? (v as DimensionUnit)
    : 'in';
}

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await db.product.findUnique({ where: { id } });
  if (!product) notFound();
  // Archived products are read-only from the UI — the detail header
  // hides the Edit button. If someone hand-types this URL, bounce them
  // back rather than letting them PUT against a soft-deleted row.
  if (product.deletedAt != null) redirect(`/products/${product.id}`);

  const defaults: Partial<ProductFormValues> = {
    sku: product.sku,
    name: product.name,
    type: product.type,
    brand: product.brand ?? '',
    category: product.category ?? '',
    basePrice: product.basePrice?.toString() ?? '',
    tracksInventory: product.tracksInventory,
    active: product.active,
    shortDescription: product.shortDescription ?? '',
    longDescription: product.longDescription ?? '',
    weight: product.weight?.toString() ?? '',
    weightUnit: asWeightUnit(product.weightUnit),
    lengthDim: product.lengthDim?.toString() ?? '',
    widthDim: product.widthDim?.toString() ?? '',
    heightDim: product.heightDim?.toString() ?? '',
    dimensionUnit: asDimensionUnit(product.dimensionUnit),
    shopifyProductId: product.shopifyProductId ?? '',
  };

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
            Edit product
          </h1>
          <p className="text-sm text-muted-foreground">
            SKU is fixed after creation. Variants are managed from the{' '}
            <Link
              href={`/products/${product.id}`}
              className="underline-offset-2 hover:underline"
            >
              Variants tab
            </Link>
            .
          </p>
        </div>
      </div>

      <ProductForm
        mode={{ kind: 'edit', productId: product.id }}
        defaultValues={defaults}
      />
    </div>
  );
}
