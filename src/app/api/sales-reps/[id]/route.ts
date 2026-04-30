import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateSalesRepInputSchema } from '@/lib/validation/salesReps';
import {
  getSalesRep,
  softDeleteSalesRep,
  updateSalesRep,
} from '@/server/services/salesReps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rep = await getSalesRep(db, id);
  if (!rep) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(rep);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updateSalesRepInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const rep = await updateSalesRep(db, id, parsed.data);
    return NextResponse.json(rep);
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
    const rep = await softDeleteSalesRep(db, id);
    return NextResponse.json(rep);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
