import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { updateInventoryBin } from '@/server/services/inventory';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Free-text; null/blank clears the bin. Cap length defensively.
const bodySchema = z.object({
  binLocation: z.string().max(120).nullable(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const item = await updateInventoryBin(
      db,
      id,
      parsed.data.binLocation,
      auditCtx,
    );
    return NextResponse.json({ id: item.id, binLocation: item.binLocation });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
