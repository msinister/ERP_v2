import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readDecryptedVendorPaymentMethodPayload } from '@/server/services/vendorPaymentMethods';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

/**
 * Audited cleartext-read endpoint for vendor payment methods (ACH /
 * WIRE / CHECK / CREDIT_CARD reference data). Every successful response
 * carries actual account numbers in the body, so it MUST NOT be cached
 * at any layer — browser, CDN, intermediate proxies.
 *
 *   - Cache-Control: no-store          → don't cache, don't store on disk
 *   - Pragma: no-cache                 → HTTP/1.0 fallback
 *
 * The service writes the SENSITIVE_READ AuditLog row BEFORE attempting
 * decryption, so the access attempt is recorded even if decrypt fails
 * (tampered ciphertext, wrong key). Mirrors customer document cleartext
 * route.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; pmid: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { pmid } = await ctx.params;
    const decrypted = await readDecryptedVendorPaymentMethodPayload(
      db,
      pmid,
      auditCtx,
    );
    return new NextResponse(JSON.stringify(decrypted), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return new NextResponse(
      JSON.stringify({ error: e instanceof Error ? e.message : 'internal' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      },
    );
  }
}
