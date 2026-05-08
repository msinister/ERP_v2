import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { softClosePeriod } from '@/server/services/fiscalPeriods';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const period = await softClosePeriod(db, id, auditCtx);
    return NextResponse.json(period);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
