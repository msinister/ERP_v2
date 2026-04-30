import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateCustomerStubInputSchema as updateCustomerInputSchema } from '@/lib/validation/customers';
import {
  getCustomer,
  softDeleteCustomer,
  updateCustomer,
} from '@/server/services/customers';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const customer = await getCustomer(db, id);
  if (!customer) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(customer);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updateCustomerInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const customer = await updateCustomer(db, id, parsed.data);
    return NextResponse.json(customer);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const customer = await softDeleteCustomer(db, id);
    return NextResponse.json(customer);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
