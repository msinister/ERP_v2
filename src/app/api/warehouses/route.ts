import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { warehouseCreateSchema } from '@/lib/validation/product';
import {
  createWarehouse,
  listWarehouses,
} from '@/server/services/warehouse';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get('includeArchived') === 'true';

  try {
    const warehouses = await listWarehouses(db, { includeArchived });
    return NextResponse.json({ warehouses });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

export async function POST(req: Request) {
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

  try {
    const warehouse = await createWarehouse(db, parsed.data);
    return NextResponse.json(warehouse, { status: 201 });
  } catch (err) {
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
