import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { journalReport } from '@/server/services/reports/financial';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const entityType = url.searchParams.get('entityType') ?? undefined;
    const accountCode = url.searchParams.get('accountCode') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '200') || 200, 1000);

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
    const report = await journalReport(db, {
      from,
      to,
      entityType,
      accountCode,
      skip,
      take,
    });
    return NextResponse.json({
      asOfFrom: report.asOfFrom?.toISOString() ?? null,
      asOfTo: report.asOfTo.toISOString(),
      entries: report.entries.map((e) => ({
        id: e.id,
        number: e.number,
        postedAt: e.postedAt.toISOString(),
        description: e.description,
        entityType: e.entityType,
        entityId: e.entityId,
        reversedAt: e.reversedAt ? e.reversedAt.toISOString() : null,
        lines: e.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          memo: l.memo,
        })),
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
