import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { exportAccountLedger, naturalBalance } from '@/server/services/glLedger';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// GET /api/gl-ledger/export?accountId=&from=&to= → text/csv download of the
// account's transaction register (newest-first), running balance in the
// account's natural orientation.

function parseDate(v: string | null, endOfDay: boolean): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function csvCell(value: string): string {
  // Quote when the value contains a comma, quote, or newline; double any
  // embedded quotes.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const accountId = url.searchParams.get('accountId');
    if (!accountId) {
      return NextResponse.json({ error: 'accountId required' }, { status: 400 });
    }
    const from = parseDate(url.searchParams.get('from'), false);
    const to = parseDate(url.searchParams.get('to'), true);

    const result = await exportAccountLedger(db, { accountId, from, to });
    if (!result) {
      return NextResponse.json({ error: 'account not found' }, { status: 404 });
    }

    const header = [
      'Date',
      'Description',
      'Memo',
      'Reference',
      'JE #',
      'Debit',
      'Credit',
      'Running Balance',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of result.rows) {
      const running = naturalBalance(r.signedRunningBalance, result.account.type);
      lines.push(
        [
          fmtDate(r.postedAt),
          r.description,
          r.memo ?? '',
          r.reference ?? '',
          r.jeNumber,
          r.debit.greaterThan(0) ? r.debit.toString() : '',
          r.credit.greaterThan(0) ? r.credit.toString() : '',
          running.toString(),
        ]
          .map((c) => csvCell(c))
          .join(','),
      );
    }
    const csv = lines.join('\r\n');

    const filename = `ledger-${result.account.code}-${fmtDate(new Date())}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
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
