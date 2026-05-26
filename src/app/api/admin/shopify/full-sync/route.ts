import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { isSyncEnabled } from '@/server/services/shopifyConfig';
import { runFullSync } from '@/server/services/shopifySync';

// Runs INLINE per pilot scale (~40 SKUs at Naked Kratom). For larger
// tenants this becomes a long-running route, which means the operator's
// browser tab needs to stay open until the response returns; if it
// closes the sync still completes server-side but the result summary is
// lost (the same summary is also persisted to the Setting row by
// recordSyncRun so the admin UI can still render it on the next page
// load). Upgrade path: move runFullSync into an Inngest job so the
// route returns immediately and the UI polls — tech-stack listed but
// not yet wired.
//
// Auth: super-admin only (sync touches every product row).

export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    const ctx = auditCtxFromRequest(req, user);

    if (!(await isSyncEnabled(db))) {
      return NextResponse.json(
        { error: 'Shopify sync is disabled — enable it in admin settings first' },
        { status: 400 },
      );
    }

    const run = await runFullSync(db, ctx);
    return NextResponse.json(run);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
