import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { trialBalance } from '@/server/services/reports/financial';
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
    const report = await trialBalance(db, { from, to });
    return NextResponse.json({
      asOfFrom: report.asOfFrom?.toISOString() ?? null,
      asOfTo: report.asOfTo.toISOString(),
      rows: report.rows.map((r) => ({
        accountId: r.accountId,
        accountCode: r.accountCode,
        accountName: r.accountName,
        accountType: r.accountType,
        beginningDebit: r.beginningDebit.toString(),
        beginningCredit: r.beginningCredit.toString(),
        periodDebits: r.periodDebits.toString(),
        periodCredits: r.periodCredits.toString(),
        endingDebit: r.endingDebit.toString(),
        endingCredit: r.endingCredit.toString(),
      })),
      totals: {
        totalBeginningDebit: report.totals.totalBeginningDebit.toString(),
        totalBeginningCredit: report.totals.totalBeginningCredit.toString(),
        totalPeriodDebits: report.totals.totalPeriodDebits.toString(),
        totalPeriodCredits: report.totals.totalPeriodCredits.toString(),
        totalEndingDebit: report.totals.totalEndingDebit.toString(),
        totalEndingCredit: report.totals.totalEndingCredit.toString(),
      },
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
