import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { agingSummary } from '@/server/services/ar';

export async function GET(req: Request) {
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
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const offset = offsetRaw ? Number(offsetRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return NextResponse.json({ error: 'invalid limit' }, { status: 400 });
  }
  if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
    return NextResponse.json({ error: 'invalid offset' }, { status: 400 });
  }
  try {
    const rows = await agingSummary(db, asOf, { limit, offset });
    return NextResponse.json({
      asOf: (asOf ?? new Date()).toISOString(),
      rows: rows.map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        current: r.current.toString(),
        b1to30: r.b1to30.toString(),
        b31to60: r.b31to60.toString(),
        b61to90: r.b61to90.toString(),
        b91plus: r.b91plus.toString(),
        total: r.total.toString(),
        unappliedCreditBalance: r.unappliedCreditBalance.toString(),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
