// =============================================================================
// Shared decimal-input helpers for form fields backed by Prisma.Decimal on
// the server. The server's `decimalString` validator expects a strict
// pattern (^-?\d+(\.\d+)?$), but operators reasonably type ".25" without
// the leading zero. These helpers let the form accept the looser
// human-typed shape and normalize before submit.
// =============================================================================

const NON_NEG_RE = /^\d*\.?\d*$/;

/**
 * True when `v` parses to a finite non-negative decimal AND its shape
 * matches what a human would type for a positive decimal: leading-zero
 * optional, trailing dot allowed mid-typing. Empty / lone-dot fail.
 */
export function isNonNegativeDecimalInput(v: string): boolean {
  if (v === '' || v === '.') return false;
  if (!NON_NEG_RE.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Same as isNonNegativeDecimalInput plus the value must be strictly > 0.
 * Use for qty fields where zero is meaningless.
 */
export function isPositiveDecimalInput(v: string): boolean {
  if (!isNonNegativeDecimalInput(v)) return false;
  return Number(v) > 0;
}

/**
 * Normalize a human-typed decimal to the canonical shape the server
 * accepts: drop trailing dots, add leading zero before bare dots, strip
 * trailing zeros after the decimal point only if no fractional content
 * follows. ".25" → "0.25". "0." → "0". "10.50" → "10.50" (preserved).
 * Returns the input unchanged when it can't parse, so caller-level
 * validation still surfaces the right error.
 */
export function normalizeDecimalForSubmit(v: string): string {
  if (!isNonNegativeDecimalInput(v)) return v;
  // Numeric round-trip handles both ".25" → "0.25" and "0." → "0".
  // We avoid Number.toString() because it would strip trailing zeros
  // ("10.50" → "10.5"), which differs from what the operator typed —
  // preserve user input when it's already in canonical form.
  if (/^\d+(\.\d+)?$/.test(v)) return v;
  return Number(v).toString();
}
