import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { CustomerType } from '@/generated/tenant';
import { createCustomerInputSchema } from '@/lib/validation/customers';
import {
  createCustomer,
  listCustomers,
} from '@/server/services/customers';

// TODO: wire requirePermission() once lib/permissions exists

export async function GET(req: Request) {
  const url = new URL(req.url);
  const activeParam = url.searchParams.get('active');
  const active =
    activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;
  const typeParam = url.searchParams.get('type') ?? undefined;
  const salesRepId = url.searchParams.get('salesRepId') ?? undefined;
  const tagId = url.searchParams.get('tagId') ?? undefined;
  const categoryId = url.searchParams.get('categoryId') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

  const list = await listCustomers(db, {
    active,
    type: typeParam as CustomerType | undefined,
    salesRepId,
    tagId,
    categoryId,
    q,
    skip,
    take,
  });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createCustomerInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const customer = await createCustomer(db, parsed.data);
    return NextResponse.json(customer, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
