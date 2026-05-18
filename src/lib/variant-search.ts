// Shared client-side filter + highlight helpers for the variant
// picker. Pulled out of the picker component so call sites can reuse
// the same scoring rule (e.g. for sorting "in-catalog" variants up).
//
// The filter is purely substring on lowercased fields — case
// insensitive, no fuzz. Good enough for <1000 variants per the
// pilot's order-of-magnitude. Server-side search will replace this
// once the catalog crosses the keystroke-latency threshold.

export type SearchableVariant = {
  sku: string;
  productName: string;
  variantName?: string | null;
  shortDescription?: string | null;
  // Optional vendor-side fields (filled by the caller when a vendor
  // is in scope). Empty / undefined → not used in matching.
  vendorSku?: string | null;
};

export function variantMatches(
  v: SearchableVariant,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (v.sku.toLowerCase().includes(q)) return true;
  if (v.productName.toLowerCase().includes(q)) return true;
  if (v.variantName && v.variantName.toLowerCase().includes(q)) return true;
  if (v.shortDescription && v.shortDescription.toLowerCase().includes(q)) {
    return true;
  }
  if (v.vendorSku && v.vendorSku.toLowerCase().includes(q)) return true;
  return false;
}

// Highlight ranges: case-insensitive substring split of `text` into
// alternating non-match / match segments. The picker renders matched
// runs with a highlight class. Returns the original text as a single
// segment when no match — caller can still render without branching.
export type HighlightSegment = { text: string; match: boolean };

export function highlightSegments(
  text: string,
  query: string,
): HighlightSegment[] {
  const q = query.trim();
  if (q === '' || text === '') return [{ text, match: false }];
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const out: HighlightSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = lowerText.indexOf(lowerQ, cursor);
    if (found === -1) {
      out.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (found > cursor) {
      out.push({ text: text.slice(cursor, found), match: false });
    }
    out.push({ text: text.slice(found, found + q.length), match: true });
    cursor = found + q.length;
  }
  return out;
}
