import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { reversePayment } from '@/server/services/payments';

const bodySchema = z.object({ reason: z.string().min(1).max(2000) });

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
    const p = await reversePayment(db, { paymentId: id, reason: parsed.data.reason });
    return NextResponse.json(p);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
