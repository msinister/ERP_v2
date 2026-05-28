import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { listPendingReviews } from '@/server/services/pendingOrderReviews';

// List pending-order-review rows. Query params:
//   status=PENDING|RESOLVED_EXISTING|RESOLVED_NEW|DISMISSED (default PENDING)
//   storeId=<id>
//   limit=<n>  (default 100)
// Returns each review with the source store name + matched customer
// summary so the list page can render rows without further round-trips.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status') ?? 'PENDING';
    const storeId = url.searchParams.get('storeId') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(Number(limitParam), 1), 500) : undefined;
    const status =
      statusParam === 'PENDING' ||
      statusParam === 'RESOLVED_EXISTING' ||
      statusParam === 'RESOLVED_NEW' ||
      statusParam === 'DISMISSED'
        ? statusParam
        : 'PENDING';
    const rows = await listPendingReviews(db, { status, storeId, limit });
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
