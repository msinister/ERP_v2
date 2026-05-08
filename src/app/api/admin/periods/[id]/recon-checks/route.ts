import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listReconChecksForPeriod } from '@/server/services/reconciliation';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// List persisted reconciliation-check snapshots for a period.
// Default returns ALL snapshots (multiple runs over time, ordered).
// Pass ?latest=1 to filter to the most recent row per checkType.

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const latestPerCheckType = url.searchParams.get('latest') === '1';
    const checks = await listReconChecksForPeriod(db, id, { latestPerCheckType });
    return NextResponse.json({
      fiscalPeriodId: id,
      latestPerCheckType,
      checks: checks.map((c) => ({
        id: c.id,
        checkType: c.checkType,
        glBalance: c.glBalance.toString(),
        subledgerBalance: c.subledgerBalance.toString(),
        difference: c.difference.toString(),
        passed: c.passed,
        details: c.details,
        checkedAt: c.checkedAt.toISOString(),
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
