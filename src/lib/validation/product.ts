import { z } from 'zod';
import { decimalString } from './common';

export const weightUnitSchema = z.enum(['oz', 'lb', 'kg', 'g']);
export const dimensionUnitSchema = z.enum(['in', 'mm', 'cm']);

// Optional inline default variant — when present, createProduct seeds the
// variant inside the same transaction. Used by the bill-line quick-create
// flow so an operator can add a brand-new product + default variant in
// one round-trip without leaving the form.
export const defaultVariantSeedSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().max(255).optional(),
});

export const productCreateSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().optional(),
  brand: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  manufacturerPartNumber: z.string().max(120).optional(),
  type: z
    .enum(['SIMPLE', 'DROP_SHIP', 'SERVICE', 'ASSEMBLED', 'BUNDLE'])
    .default('SIMPLE'),
  tracksInventory: z.boolean().default(true),
  basePrice: decimalString.optional(),
  weight: decimalString.optional(),
  weightUnit: weightUnitSchema.optional(),
  lengthDim: decimalString.optional(),
  widthDim: decimalString.optional(),
  heightDim: decimalString.optional(),
  dimensionUnit: dimensionUnitSchema.optional(),
  countryOfOrigin: z.string().max(120).optional(),
  hsCode: z.string().max(64).optional(),
  hazmat: z.boolean().default(false),
  shopifyProductId: z.string().optional(),
  active: z.boolean().default(true),
  defaultVariant: defaultVariantSeedSchema.optional(),
});

// Update never seeds a variant; strip the create-only field so a malformed
// PUT payload can't smuggle a `defaultVariant` key into Prisma's update args.
export const productUpdateSchema = productCreateSchema
  .omit({ defaultVariant: true })
  .partial();

export const variantCreateSchema = z.object({
  productId: z.string().min(1),
  sku: z.string().min(1).max(64),
  name: z.string().max(255).optional(),
  variantGroup: z.string().max(120).optional(),
  color: z.string().max(120).optional(),
  flavor: z.string().max(120).optional(),
  size: z.string().max(120).optional(),
  active: z.boolean().default(true),
});

export const variantUpdateSchema = variantCreateSchema.partial();

export const warehouseCreateSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  active: z.boolean().default(true),
});

export const warehouseUpdateSchema = warehouseCreateSchema.partial();

const positiveDecimal = decimalString.refine(
  (v) => Number(v) > 0,
  'Must be greater than 0',
);

// BOM (Bill of Materials) — defines the components required to build
// one finished unit of a parent product. Used by `setProductBom` to
// wholesale-replace the BOM lines and labor cost. `laborCost` is
// nullable: explicit null clears any existing labor cost.
export const bomLineInputSchema = z.object({
  componentVariantId: z.string().min(1),
  qtyRequired: positiveDecimal,
  sortOrder: z.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

export const setProductBomInputSchema = z.object({
  lines: z.array(bomLineInputSchema),
  laborCost: decimalString.nullable().optional(),
});

// Product tag name — trimmed, 1..64 chars. Citext column handles
// case-insensitive uniqueness; we just normalize whitespace here.
export const productTagNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(64));

export const productTagsPatchSchema = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

export type ProductTagsPatchInput = z.infer<typeof productTagsPatchSchema>;

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type VariantCreateInput = z.infer<typeof variantCreateSchema>;
export type VariantUpdateInput = z.infer<typeof variantUpdateSchema>;
export type WarehouseCreateInput = z.infer<typeof warehouseCreateSchema>;
export type WarehouseUpdateInput = z.infer<typeof warehouseUpdateSchema>;
export type BomLineInput = z.infer<typeof bomLineInputSchema>;
export type SetProductBomInput = z.infer<typeof setProductBomInputSchema>;