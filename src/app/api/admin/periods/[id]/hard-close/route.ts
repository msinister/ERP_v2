import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { hardClosePeriod } from '@/server/services/fiscalPeriods';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

const bodySchema = z
  .object({
    forceCloseWithDiscrepancies: z
      .object({ reason: z.string().min(1).max(2000) })
      .optional(),
  })
  .optional();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown = undefined;
    // Body is optional — bare POST hard-closes without override.
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const period = await hardClosePeriod(db, id, parsed.data ?? {}, auditCtx);
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
