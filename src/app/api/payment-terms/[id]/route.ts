import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updatePaymentTermInputSchema } from '@/lib/validation/paymentTerms';
import {
  getPaymentTerm,
  softDeletePaymentTerm,
  updatePaymentTerm,
} from '@/server/services/paymentTerms';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const term = await getPaymentTerm(db, id);
  if (!term) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(term);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updatePaymentTermInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const term = await updatePaymentTerm(db, id, parsed.data);
    return NextResponse.json(term);
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
    const term = await softDeletePaymentTerm(db, id);
    return NextResponse.json(term);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
