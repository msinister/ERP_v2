import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { voidCreditMemo } from '@/server/services/creditMemos';

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
    const cm = await voidCreditMemo(db, id, parsed.data.reason);
    return NextResponse.json(cm);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
