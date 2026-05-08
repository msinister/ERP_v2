import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { balanceSheet } from '@/server/services/reports/financial';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const asOfParam = url.searchParams.get('asOf');
    if (!asOfParam) {
      return NextResponse.json(
        { error: 'asOf parameter is required' },
        { status: 400 },
      );
    }
    const asOf = new Date(asOfParam);
    if (Number.isNaN(asOf.getTime())) {
      return NextResponse.json(
        { error: 'invalid asOf date parameter' },
        { status: 400 },
      );
    }
    const report = await balanceSheet(db, asOf);
    return NextResponse.json({
      asOf: report.asOf.toISOString(),
      assets: {
        rows: report.assets.rows.map((r) => ({
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          balance: r.balance.toString(),
        })),
        total: report.assets.total.toString(),
      },
      liabilities: {
        rows: report.liabilities.rows.map((r) => ({
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          balance: r.balance.toString(),
        })),
        total: report.liabilities.total.toString(),
      },
      equity: {
        rows: report.equity.rows.map((r) => ({
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountName: r.accountName,
          balance: r.balance.toString(),
        })),
        currentPeriodEarnings: report.equity.currentPeriodEarnings.toString(),
        total: report.equity.total.toString(),
      },
      totalLiabilitiesAndEquity: report.totalLiabilitiesAndEquity.toString(),
      imbalance: report.imbalance.toString(),
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
