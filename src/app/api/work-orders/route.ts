import { NextResponse } from 'next/server';
import { WorkOrderStatus } from '@/generated/tenant';
import { db } from '@/lib/db';
import { createWorkOrderInputSchema } from '@/lib/validation/workOrders';
import {
  createWorkOrder,
  listWorkOrdersPaged,
} from '@/server/services/workOrders';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// GET /api/work-orders — list with optional status / product / warehouse
// filters + skip/take pagination. Defaults to 50 rows.
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'work_orders.view');
    const url = new URL(req.url);
    const statusRaw = url.searchParams.get('status');
    const status =
      statusRaw && statusRaw in WorkOrderStatus
        ? (statusRaw as WorkOrderStatus)
        : undefined;
    const productId = url.searchParams.get('productId') ?? undefined;
    const warehouseId = url.searchParams.get('warehouseId') ?? undefined;
    const skip = parseIntOrZero(url.searchParams.get('skip'));
    const take = Math.min(
      200,
      parseIntOrZero(url.searchParams.get('take')) || 50,
    );

    const result = await listWorkOrdersPaged(db, {
      status,
      productId,
      warehouseId,
      skip,
      take,
    });
    return NextResponse.json(result);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// POST /api/work-orders — create a Draft work order. Body:
//   { productId, variantId, warehouseId, qtyToBuild,
//     laborCost?: string|null, notes? }
export async function POST(req: Request) {
  try {
    const user = await requirePermission(req, 'work_orders.create');
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createWorkOrderInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const wo = await createWorkOrder(
      db,
      {
        ...parsed.data,
        createdById: parsed.data.createdById ?? user.id,
      },
      auditCtx,
    );
    return NextResponse.json(wo);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

function parseIntOrZero(v: string | null): number {
  if (v == null) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
