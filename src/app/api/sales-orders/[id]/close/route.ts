import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { closeSalesOrderInputSchema } from '@/lib/validation/sales';
import { closeSalesOrder } from '@/server/services/salesOrders';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    let body: unknown = {};
    // body is optional — close can be called with no payload
    if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: 'invalid json' }, { status: 400 });
      }
    }
    const parsed = closeSalesOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const so = await closeSalesOrder(db, id, parsed.data, auditCtx);
    return NextResponse.json(so);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
