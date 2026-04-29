import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelReceiptInputSchema } from '@/lib/validation/receipts';
import { cancelReceipt } from '@/server/services/receipts';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = cancelReceiptInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const r = await cancelReceipt(db, id, parsed.data);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
