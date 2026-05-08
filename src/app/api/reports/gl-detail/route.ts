import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { glDetail } from '@/server/services/reports/financial';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const accountCode = url.searchParams.get('accountCode');
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if (!accountCode) {
      return NextResponse.json(
        { error: 'accountCode parameter is required' },
        { status: 400 },
      );
    }
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
    const report = await glDetail(db, { accountCode, from, to });
    return NextResponse.json({
      accountId: report.accountId,
      accountCode: report.accountCode,
      accountName: report.accountName,
      accountType: report.accountType,
      asOfFrom: report.asOfFrom?.toISOString() ?? null,
      asOfTo: report.asOfTo.toISOString(),
      beginningBalance: report.beginningBalance.toString(),
      endingBalance: report.endingBalance.toString(),
      totalDebits: report.totalDebits.toString(),
      totalCredits: report.totalCredits.toString(),
      rows: report.rows.map((r) => ({
        jeNumber: r.jeNumber,
        jeId: r.jeId,
        postedAt: r.postedAt.toISOString(),
        description: r.description,
        memo: r.memo,
        entityType: r.entityType,
        entityId: r.entityId,
        debit: r.debit.toString(),
        credit: r.credit.toString(),
        runningBalance: r.runningBalance.toString(),
      })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
