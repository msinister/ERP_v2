import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCustomer } from '@/server/services/customers';
import { getActor } from '@/lib/permissions/getActor';
import { customerScopeWhere } from '@/lib/permissions/scope';
import {
  getCustomerLedger,
  parseLedgerDate,
  parseLedgerType,
  CUSTOMER_LEDGER_TYPES,
} from '@/server/services/entityLedger';
import { LEDGER_TYPE_META } from '@/components/ledger/ledger-register';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// GET /api/customers/[id]/ledger/export?from=&to=&type=&sort= → text/csv of
// the customer's transaction register with running balance. Enforces the
// same data-scope as the customer detail page (a "view own" rep can't
// export another rep's customer ledger).

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req);
    const actor = await getActor();
    if (!actor) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const { id } = await ctx.params;
    // Scope check — out-of-scope customers resolve to null → 404.
    const customer = await getCustomer(db, id, customerScopeWhere(actor));
    if (!customer) {
      return NextResponse.json({ error: 'customer not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const from = parseLedgerDate(url.searchParams.get('from'), false);
    const to = parseLedgerDate(url.searchParams.get('to'), true);
    const type = parseLedgerType(url.searchParams.get('type'), CUSTOMER_LEDGER_TYPES);
    const sort = url.searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest';

    const ledger = await getCustomerLedger(db, id, {
      from,
      to,
      type,
      sort,
      skip: 0,
      take: 1_000_000,
    });

    const header = [
      'Date',
      'Type',
      'Reference',
      'Description',
      'Debit',
      'Credit',
      'Running Balance',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of ledger.rows) {
      lines.push(
        [
          fmtDate(r.date),
          LEDGER_TYPE_META[r.type]?.label ?? r.type,
          r.number,
          r.description,
          r.debit.greaterThan(0) ? r.debit.toString() : '',
          r.credit.greaterThan(0) ? r.credit.toString() : '',
          r.runningBalance.toString(),
        ]
          .map((c) => csvCell(c))
          .join(','),
      );
    }
    const csv = lines.join('\r\n');

    const filename = `customer-ledger-${customer.code}-${fmtDate(new Date())}.csv`;
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
