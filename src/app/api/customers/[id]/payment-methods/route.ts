import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createPaymentMethodInputSchema } from '@/lib/validation/customers';
import {
  createPaymentMethod,
  listPaymentMethodsForCustomer,
} from '@/server/services/customerPaymentMethods';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const list = await listPaymentMethodsForCustomer(db, id);
  return NextResponse.json(list);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createPaymentMethodInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const pm = await createPaymentMethod(db, id, parsed.data);
    return NextResponse.json(pm, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
