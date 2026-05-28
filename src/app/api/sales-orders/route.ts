import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { SalesOrderStatus } from '@/generated/tenant';
import { createSalesOrderInputSchema } from '@/lib/validation/sales';
import {
  createSalesOrder,
  listSalesOrders,
} from '@/server/services/salesOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { assertCustomerInScope } from '@/lib/permissions/scope';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'sales_orders.view_all');
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in SalesOrderStatus
        ? (statusParam as SalesOrderStatus)
        : undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

    const list = await listSalesOrders(db, { customerId, status, skip, take });
    return NextResponse.json(list);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requirePermission(req, 'sales_orders.create');
    const auditCtx = auditCtxFromRequest(req, actor);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createSalesOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    // Scope check: a "view own" rep can only create SOs for their own
    // customers. Super Admin / view_all is unrestricted.
    await assertCustomerInScope(db, actor, parsed.data.customerId);
    const so = await createSalesOrder(db, parsed.data, auditCtx);
    return NextResponse.json(so, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
