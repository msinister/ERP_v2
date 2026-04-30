import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { decimalString } from '@/lib/validation/common';
import { applyCreditToInvoice } from '@/server/services/payments';

const bodySchema = z.object({
  invoiceId: z.string().min(1),
  amount: decimalString.refine((v) => Number(v) > 0, 'Must be greater than 0'),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const app = await applyCreditToInvoice(db, {
      creditMemoId: id,
      invoiceId: parsed.data.invoiceId,
      amount: parsed.data.amount,
    });
    return NextResponse.json(app, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
