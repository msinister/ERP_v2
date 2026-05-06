import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readEncryptedValue } from '@/server/services/customerDocuments';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

/**
 * Audited cleartext-read endpoint for sensitive customer documents
 * (EIN / SSN / DRIVERS_LICENSE). Every successful response carries
 * actual PII in the body, so the response MUST NOT be cached at any
 * layer (browser, CDN, intermediate proxies).
 *
 * We set:
 *   - Cache-Control: no-store          → don't cache, don't store on disk
 *   - Pragma: no-cache                 → HTTP/1.0 fallback
 *
 * Service-layer wrote the SENSITIVE_READ AuditLog row before this
 * route returns; the response body is never persisted server-side.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { did } = await ctx.params;
    const value = await readEncryptedValue(db, did, auditCtx);
    return new NextResponse(JSON.stringify({ value }), {
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
