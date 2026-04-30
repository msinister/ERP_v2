import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { arBalanceForCustomer } from '@/server/services/ar';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const asOfRaw = url.searchParams.get('asOf');
  let asOf: Date | undefined;
  if (asOfRaw) {
    const parsed = new Date(asOfRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'invalid asOf — must be ISO 8601' },
        { status: 400 },
      );
    }
    asOf = parsed;
  }
  try {
    const result = await arBalanceForCustomer(db, id, asOf);
    return NextResponse.json({
      arBalance: result.arBalance.toString(),
      unappliedCreditBalance: result.unappliedCreditBalance.toString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
