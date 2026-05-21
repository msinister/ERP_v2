import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { CustomerType } from '@/generated/tenant';
import { createCustomerInputSchema } from '@/lib/validation/customers';
import {
  createCustomer,
  listCustomers,
} from '@/server/services/customers';
import { requireAuth } from '@/lib/auth/requireAuth';
import { loadActor } from '@/lib/permissions/actor';
import { customerScopeWhere } from '@/lib/permissions/scope';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    const user = await requireAuth(req);
    // Data-scope: a "view own" actor only gets their assigned customers.
    const actor = await loadActor(db, user.id);
    if (!actor) return NextResponse.json([], { status: 200 });

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
      scope: customerScopeWhere(actor),
      skip,
      take,
    });
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
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);

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
    const customer = await createCustomer(db, parsed.data, auditCtx);
    return NextResponse.json(customer, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
