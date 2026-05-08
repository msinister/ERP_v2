import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { FiscalPeriodStatus } from '@/generated/tenant';
import { listPeriods } from '@/server/services/fiscalPeriods';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Admin-only — period management is an accountant operation. The
// future permissions slice will add a finer-grained role for AP/AR
// staff vs. period close. For pilot, only super admins manage periods.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in FiscalPeriodStatus
        ? (statusParam as FiscalPeriodStatus)
        : undefined;
    const yearParam = url.searchParams.get('year');
    const year = yearParam ? Number(yearParam) : undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);
    const list = await listPeriods(db, { status, year, skip, take });
    return NextResponse.json(list);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
