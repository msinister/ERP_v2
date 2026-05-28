import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { resolvePendingOrderReview } from '@/server/services/pendingOrderReviews';

const resolveBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('use_existing'),
    customerId: z.string().min(1),
    addAsNewAddress: z.boolean().optional(),
  }),
  z.object({ action: z.literal('create_new') }),
  z.object({
    action: z.literal('dismiss'),
    reason: z.string().max(2000).optional(),
  }),
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = resolveBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid body', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const result = await resolvePendingOrderReview(db, id, parsed.data, auditCtx);
    if (result.outcome === 'error') {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
