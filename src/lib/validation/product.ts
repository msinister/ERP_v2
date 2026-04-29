import { z } from 'zod';
import { decimalString } from './common';

export const productCreateSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().optional(),
  brand: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  type: z.enum(['SIMPLE', 'DROP_SHIP', 'SERVICE']).default('SIMPLE'),
  tracksInventory: z.boolean().default(true),
  basePrice: decimalString.optional(),
  weight: decimalString.optional(),
  lengthDim: decimalString.optional(),
  widthDim: decimalString.optional(),
  heightDim: decimalString.optional(),
  shopifyProductId: z.string().optional(),
  active: z.boolean().default(true),
});

export const productUpdateSchema = productCreateSchema.partial();

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

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type VariantCreateInput = z.infer<typeof variantCreateSchema>;
export type VariantUpdateInput = z.infer<typeof variantUpdateSchema>;
export type WarehouseCreateInput = z.infer<typeof warehouseCreateSchema>;
export type WarehouseUpdateInput = z.infer<typeof warehouseUpdateSchema>;