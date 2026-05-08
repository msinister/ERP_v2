import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runAllReconChecks } from '@/server/services/reconciliation';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Run reconciliation checks against a period without closing it.
// Persists the snapshot rows + writes a RECONCILIATION_RUN audit row.

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const results = await runAllReconChecks(db, id, auditCtx);
    return NextResponse.json({
      fiscalPeriodId: id,
      checkCount: results.length,
      passedCount: results.filter((r) => r.passed).length,
      failedCount: results.filter((r) => !r.passed).length,
      results: results.map((r) => ({
        checkType: r.checkType,
        glBalance: r.glBalance.toString(),
        subledgerBalance: r.subledgerBalance.toString(),
        difference: r.difference.toString(),
        passed: r.passed,
        details: r.details,
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
