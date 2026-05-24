import type { PrismaClient } from '@/generated/tenant';
import type { AuditContext } from '@/lib/audit/audit';
import type { ProductCreateInput } from '@/lib/validation/product';
import { createProduct, getProductBySku, updateProduct } from './products';
import { addProductImage, setPrimaryProductImage } from './productImages';
import { setProductTags } from './productTags';

// =============================================================================
// Product CSV import. The client maps + pre-validates rows and POSTs them as
// JSON (no raw file server-side). This service coerces the loose CSV strings
// into the product field shapes and create/updates each row in its own
// transaction (via createProduct / updateProduct) so one bad row never rolls
// back the rest of the batch. No inventory is touched — master data only.
// Each created product seeds a default variant with the product SKU, exactly
// like the UI create flow.
// =============================================================================

export type ImportMode = 'skip' | 'update';

// Raw mapped row from the client. Every field arrives as a string (CSV) or
// undefined when the column wasn't mapped / was blank. rowNumber is the
// 1-based source-file row, echoed back for error reporting.
export type ImportRowInput = {
  rowNumber: number;
  sku?: string;
  name?: string;
  shortDescription?: string;
  longDescription?: string;
  brand?: string;
  category?: string;
  manufacturerPartNumber?: string;
  basePrice?: string;
  weight?: string;
  weightUnit?: string;
  lengthDim?: string;
  widthDim?: string;
  heightDim?: string;
  dimensionUnit?: string;
  countryOfOrigin?: string;
  hsCode?: string;
  hazmat?: string;
  active?: string;
  type?: string;
  imageUrl?: string;
  // Comma-separated tag names; auto-created + assigned (additive).
  tags?: string;
};

export type ImportRowStatus = 'created' | 'updated' | 'skipped' | 'error';

export type ImportRowResult = {
  rowNumber: number;
  sku: string;
  status: ImportRowStatus;
  message?: string;
};

export const IMPORT_MAX_BATCH = 100;

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function clean(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

// Strip currency symbols, thousands separators, and whitespace so loose
// spreadsheet values ("$1,250.00") pass the strict decimalString validator.
function cleanNumber(v: string | undefined): string | undefined {
  const s = clean(v);
  if (s == null) return undefined;
  const stripped = s.replace(/[$,\s]/g, '');
  return stripped === '' ? undefined : stripped;
}

// undefined when not provided so update mode only touches mapped columns and
// create mode falls through to the schema default.
function parseBool(v: string | undefined): boolean | undefined {
  const s = clean(v);
  if (s == null) return undefined;
  const lower = s.toLowerCase();
  if (['true', 'yes', 'y', '1', 't'].includes(lower)) return true;
  if (['false', 'no', 'n', '0', 'f'].includes(lower)) return false;
  return undefined;
}

const PRODUCT_TYPES = new Set([
  'SIMPLE',
  'DROP_SHIP',
  'SERVICE',
  'ASSEMBLED',
  'BUNDLE',
]);

function parseType(
  v: string | undefined,
): ProductCreateInput['type'] | undefined {
  const s = clean(v);
  if (s == null) return undefined;
  const upper = s.toUpperCase().replace(/[\s-]+/g, '_');
  const normalized = upper === 'DROPSHIP' ? 'DROP_SHIP' : upper;
  return PRODUCT_TYPES.has(normalized)
    ? (normalized as ProductCreateInput['type'])
    : undefined;
}

const WEIGHT_UNITS = new Set(['oz', 'lb', 'kg', 'g']);
function parseWeightUnit(
  v: string | undefined,
): ProductCreateInput['weightUnit'] | undefined {
  const s = clean(v);
  if (s == null) return undefined;
  const lower = s.toLowerCase();
  return WEIGHT_UNITS.has(lower)
    ? (lower as ProductCreateInput['weightUnit'])
    : undefined;
}

const DIM_UNITS = new Set(['in', 'mm', 'cm']);
function parseDimUnit(
  v: string | undefined,
): ProductCreateInput['dimensionUnit'] | undefined {
  const s = clean(v);
  if (s == null) return undefined;
  const lower = s.toLowerCase();
  return DIM_UNITS.has(lower)
    ? (lower as ProductCreateInput['dimensionUnit'])
    : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

// Split a comma-separated tag cell into de-duped, trimmed names.
function parseTags(v: string | undefined): string[] {
  const s = clean(v);
  if (s == null) return [];
  return Array.from(
    new Set(s.split(',').map((t) => t.trim()).filter(Boolean)),
  );
}

function isValidHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Attach an external image URL to a product as its primary image.
//   - new product: it has no images yet → the new image becomes primary.
//   - existing product without a primary image: create + promote to primary.
//   - existing product that already has a primary image: skip (never
//     overwrite existing images).
// The URL is referenced as-is (no download/re-upload).
async function applyImageUrl(
  db: PrismaClient,
  productId: string,
  url: string,
  isNewProduct: boolean,
  ctx?: AuditContext,
): Promise<void> {
  if (!isNewProduct) {
    const primary = await db.productImage.findFirst({
      where: { productId, isPrimary: true, deletedAt: null },
      select: { id: true },
    });
    if (primary) return; // don't overwrite an existing primary image
  }
  const created = await addProductImage(db, productId, { url }, ctx);
  // addProductImage only auto-primaries the very first image; if the
  // product had non-primary images but no primary, promote this one.
  if (!created.isPrimary) {
    await setPrimaryProductImage(db, productId, created.id, ctx);
  }
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importProductRows(
  db: PrismaClient,
  mode: ImportMode,
  rows: ImportRowInput[],
  ctx?: AuditContext,
): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];

  for (const row of rows) {
    const sku = clean(row.sku) ?? '';
    try {
      if (!sku) {
        results.push({
          rowNumber: row.rowNumber,
          sku: '',
          status: 'error',
          message: 'SKU is required',
        });
        continue;
      }
      const name = clean(row.name);
      if (!name) {
        results.push({
          rowNumber: row.rowNumber,
          sku,
          status: 'error',
          message: 'Name is required',
        });
        continue;
      }

      const imageUrl = clean(row.imageUrl);
      if (imageUrl && !isValidHttpUrl(imageUrl)) {
        results.push({
          rowNumber: row.rowNumber,
          sku,
          status: 'error',
          message: 'Invalid image URL (must start with http:// or https://)',
        });
        continue;
      }

      const tagNames = parseTags(row.tags);

      // Common field set. undefined values are stripped so they don't
      // overwrite on update or fight the create-schema defaults.
      const fields = {
        name,
        shortDescription: clean(row.shortDescription),
        longDescription: clean(row.longDescription),
        brand: clean(row.brand),
        category: clean(row.category),
        manufacturerPartNumber: clean(row.manufacturerPartNumber),
        basePrice: cleanNumber(row.basePrice),
        weight: cleanNumber(row.weight),
        weightUnit: parseWeightUnit(row.weightUnit),
        lengthDim: cleanNumber(row.lengthDim),
        widthDim: cleanNumber(row.widthDim),
        heightDim: cleanNumber(row.heightDim),
        dimensionUnit: parseDimUnit(row.dimensionUnit),
        countryOfOrigin: clean(row.countryOfOrigin),
        hsCode: clean(row.hsCode),
        hazmat: parseBool(row.hazmat),
        active: parseBool(row.active),
        type: parseType(row.type),
      };

      const existing = await getProductBySku(db, sku);

      if (existing) {
        if (mode === 'skip') {
          results.push({
            rowNumber: row.rowNumber,
            sku,
            status: 'skipped',
            message: 'SKU already exists',
          });
          continue;
        }
        // Update: only the columns present in the file. Never touches the
        // variant or deletes anything.
        await updateProduct(db, existing.id, stripUndefined(fields), ctx);
        if (imageUrl) {
          await applyImageUrl(db, existing.id, imageUrl, false, ctx);
        }
        if (tagNames.length > 0) {
          await setProductTags(db, existing.id, { add: tagNames }, ctx);
        }
        results.push({ rowNumber: row.rowNumber, sku, status: 'updated' });
      } else {
        const created = await createProduct(
          db,
          {
            sku,
            ...stripUndefined(fields),
            defaultVariant: { sku },
          } as ProductCreateInput,
          ctx,
        );
        if (imageUrl) {
          await applyImageUrl(db, created.id, imageUrl, true, ctx);
        }
        if (tagNames.length > 0) {
          await setProductTags(db, created.id, { add: tagNames }, ctx);
        }
        results.push({ rowNumber: row.rowNumber, sku, status: 'created' });
      }
    } catch (e) {
      results.push({
        rowNumber: row.rowNumber,
        sku,
        status: 'error',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }

  return results;
}
