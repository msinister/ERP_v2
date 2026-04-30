import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { transitionRmaInputSchema } from '@/lib/validation/invoicing';
import { transitionRma } from '@/server/services/rmas';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = transitionRmaInputSchema.safeParse({ ...(body as object), rmaId: id });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const rma = await transitionRma(db, parsed.data);
    return NextResponse.json(rma);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
