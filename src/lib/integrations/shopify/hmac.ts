import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Shopify webhook HMAC verification. Shopify signs every webhook POST body
// with HMAC-SHA256 using the shop's webhook signing secret and sends the
// base64-encoded result in the `X-Shopify-Hmac-Sha256` header.
//
// The verifier MUST run against the EXACT raw request body bytes — any
// JSON re-stringify changes whitespace and breaks the signature. Use
// `await req.text()` (NOT req.json()) to get the bytes, verify, THEN
// JSON.parse for processing.
//
// Comparison uses timingSafeEqual so a malicious sender can't probe the
// signature byte-by-byte via response timing.
// =============================================================================

export function verifyShopifyHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch — short-circuit first so the
  // attacker can't tell "wrong length" from "right length / wrong bytes".
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
