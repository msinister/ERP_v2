// Product import — target field catalog + header auto-detection. Pure
// module (no React) so it stays easy to reason about and reuse.

export type ProductFieldKey =
  | 'sku'
  | 'name'
  | 'shortDescription'
  | 'longDescription'
  | 'brand'
  | 'category'
  | 'basePrice'
  | 'weight'
  | 'weightUnit'
  | 'lengthDim'
  | 'widthDim'
  | 'heightDim'
  | 'dimensionUnit'
  | 'countryOfOrigin'
  | 'hsCode'
  | 'hazmat'
  | 'active'
  | 'type';

export type ProductFieldDef = {
  key: ProductFieldKey;
  label: string;
  required?: boolean;
  // Normalized header tokens that auto-map to this field.
  aliases: string[];
};

export const PRODUCT_FIELDS: ProductFieldDef[] = [
  { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'skucode', 'itemnumber', 'itemno', 'item', 'partnumber', 'partno'] },
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'productname', 'title', 'itemname'] },
  { key: 'shortDescription', label: 'Short description', aliases: ['shortdescription', 'shortdesc', 'summary'] },
  { key: 'longDescription', label: 'Long description', aliases: ['longdescription', 'longdesc', 'description', 'desc', 'details'] },
  { key: 'brand', label: 'Brand', aliases: ['brand', 'manufacturer', 'make'] },
  { key: 'category', label: 'Category', aliases: ['category', 'cat', 'group', 'department'] },
  { key: 'basePrice', label: 'Base price', aliases: ['baseprice', 'price', 'unitprice', 'listprice', 'msrp', 'retailprice'] },
  { key: 'weight', label: 'Weight', aliases: ['weight', 'wt'] },
  { key: 'weightUnit', label: 'Weight unit (lb/kg)', aliases: ['weightunit', 'wtunit', 'weightuom'] },
  { key: 'lengthDim', label: 'Length', aliases: ['length', 'len'] },
  { key: 'widthDim', label: 'Width', aliases: ['width'] },
  { key: 'heightDim', label: 'Height', aliases: ['height'] },
  { key: 'dimensionUnit', label: 'Dimension unit (in/cm)', aliases: ['dimensionunit', 'dimunit', 'dimensionuom'] },
  { key: 'countryOfOrigin', label: 'Country of origin', aliases: ['countryoforigin', 'coo', 'country', 'origin', 'madein'] },
  { key: 'hsCode', label: 'HS code', aliases: ['hscode', 'hs', 'harmonizedcode', 'tariffcode', 'htscode', 'hts'] },
  { key: 'hazmat', label: 'Hazmat (yes/no)', aliases: ['hazmat', 'hazardous', 'dangerousgoods', 'dg'] },
  { key: 'active', label: 'Active (yes/no)', aliases: ['active', 'enabled'] },
  { key: 'type', label: 'Product type', aliases: ['type', 'producttype', 'kind'] },
];

export const FIELD_BY_KEY: Record<ProductFieldKey, ProductFieldDef> =
  Object.fromEntries(PRODUCT_FIELDS.map((f) => [f.key, f])) as Record<
    ProductFieldKey,
    ProductFieldDef
  >;

// Sentinel for "don't import this column".
export const UNMAPPED = '__unmapped__';

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a header → fieldKey auto-mapping. Saved per-header preferences (from
// localStorage) win over alias matching. First column to claim a field wins;
// later columns for an already-claimed field stay unmapped so the operator
// resolves the ambiguity explicitly.
export function autoDetectMapping(
  headers: string[],
  saved: Record<string, ProductFieldKey> = {},
): Record<string, ProductFieldKey | typeof UNMAPPED> {
  const result: Record<string, ProductFieldKey | typeof UNMAPPED> = {};
  const claimed = new Set<ProductFieldKey>();

  for (const header of headers) {
    const norm = normalizeHeader(header);
    let match: ProductFieldKey | undefined = saved[norm];
    if (match && claimed.has(match)) match = undefined;
    if (!match) {
      for (const f of PRODUCT_FIELDS) {
        if (claimed.has(f.key)) continue;
        if (f.aliases.includes(norm)) {
          match = f.key;
          break;
        }
      }
    }
    if (match) {
      claimed.add(match);
      result[header] = match;
    } else {
      result[header] = UNMAPPED;
    }
  }
  return result;
}
