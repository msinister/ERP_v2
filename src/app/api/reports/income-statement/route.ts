import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { incomeStatement } from '@/server/services/reports/financial';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if (!toParam) {
      return NextResponse.json(
        { error: 'to parameter is required' },
        { status: 400 },
      );
    }
    const from = fromParam ? new Date(fromParam) : undefined;
    const to = new Date(toParam);
    if (Number.isNaN(to.getTime()) || (from && Number.isNaN(from.getTime()))) {
      return NextResponse.json(
        { error: 'invalid date parameter' },
        { status: 400 },
      );
    }
    const report = await incomeStatement(db, { from, to });
    return NextResponse.json({
      asOfFrom: report.asOfFrom?.toISOString() ?? null,
      asOfTo: report.asOfTo.toISOString(),
      revenue: {
        rows: report.revenue.rows.map((r) => ({
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          amount: r.amount.toString(),
        })),
        total: report.revenue.total.toString(),
      },
      expenses: {
        rows: report.expenses.rows.map((r) => ({
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          amount: r.amount.toString(),
        })),
        total: report.expenses.total.toString(),
      },
      netIncome: report.netIncome.toString(),
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
