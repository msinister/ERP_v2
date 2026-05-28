import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { setProductPrimaryVendor } from '@/server/services/vendorProducts';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// vendorId null clears the primary vendor.
const bodySchema = z.object({ vendorId: z.string().min(1).nullable() });

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requirePermission(req, 'products.edit');
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
    const vendor = await setProductPrimaryVendor(
      db,
      id,
      parsed.data.vendorId,
      auditCtx,
    );
    return NextResponse.json({ vendor });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
