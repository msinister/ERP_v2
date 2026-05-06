import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { bulkImportFromCsv } from '@/server/services/customerPriceOverrides';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Accepts text/plain CSV in the request body. UPSERT-only — see
// bulkImportFromCsv JSDoc for the contract. Per-row failures land in
// the `errors` array; the whole-import response always returns 200
// even when some rows failed (caller decides how to surface).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let csvText: string;
    try {
      csvText = await req.text();
    } catch {
      return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
    }
    const result = await bulkImportFromCsv(db, id, csvText, auditCtx);
    return NextResponse.json(result);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
