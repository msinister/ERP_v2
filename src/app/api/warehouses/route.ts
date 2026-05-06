import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { warehouseCreateSchema } from '@/lib/validation/product';
import {
  createWarehouse,
  listWarehouses,
} from '@/server/services/warehouse';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    const warehouses = await listWarehouses(db, { includeArchived });
    return NextResponse.json({ warehouses });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    const parsed = warehouseCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const warehouse = await createWarehouse(db, parsed.data, auditCtx);
    return NextResponse.json(warehouse, { status: 201 });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'code already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
