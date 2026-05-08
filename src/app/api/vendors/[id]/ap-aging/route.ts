import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { agingForVendor } from '@/server/services/ap';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get('asOf');
    const asOf = asOfParam ? new Date(asOfParam) : new Date();
    const detail = await agingForVendor(db, id, asOf);
    // Decimal → string serialization for JSON safety.
    return NextResponse.json({
      vendorId: detail.vendorId,
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
      bills: detail.bills.map((b) => ({
        billId: b.billId,
        number: b.number,
        vendorReference: b.vendorReference,
        billDate: b.billDate.toISOString(),
        dueDate: b.dueDate.toISOString(),
        daysPastDue: b.daysPastDue,
        total: b.total.toString(),
        amountPaid: b.amountPaid.toString(),
        amountCredited: b.amountCredited.toString(),
        balance: b.balance.toString(),
        bucket: b.bucket,
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
