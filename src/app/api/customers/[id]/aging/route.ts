import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { agingForCustomer } from '@/server/services/ar';

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
    const detail = await agingForCustomer(db, id, asOf);
    return NextResponse.json({
      customerId: detail.customerId,
      asOf: detail.asOf.toISOString(),
      buckets: {
        current: detail.buckets.current.toString(),
        b1to30: detail.buckets.b1to30.toString(),
        b31to60: detail.buckets.b31to60.toString(),
        b61to90: detail.buckets.b61to90.toString(),
        b91plus: detail.buckets.b91plus.toString(),
      },
      total: detail.total.toString(),
      unappliedCreditBalance: detail.unappliedCreditBalance.toString(),
      invoices: detail.invoices.map((row) => ({
        invoiceId: row.invoiceId,
        number: row.number,
        invoiceDate: row.invoiceDate.toISOString(),
        dueDate: row.dueDate.toISOString(),
        daysPastDue: row.daysPastDue,
        total: row.total.toString(),
        amountPaid: row.amountPaid.toString(),
        amountCredited: row.amountCredited.toString(),
        balance: row.balance.toString(),
        bucket: row.bucket,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
