import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { decimalString } from '@/lib/validation/common';
import {
  softDeleteOverride,
  updateOverride,
} from '@/server/services/customerPriceOverrides';

const updateInputSchema = z.object({
  unitPrice: decimalString
    .refine((v) => Number(v) > 0, 'Must be greater than 0')
    .optional(),
  currency: z.string().min(3).max(3).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; oid: string }> },
) {
  const { oid } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const updated = await updateOverride(db, oid, parsed.data);
    return NextResponse.json(updated);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; oid: string }> },
) {
  const { oid } = await ctx.params;
  try {
    const deleted = await softDeleteOverride(db, oid);
    return NextResponse.json(deleted);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
