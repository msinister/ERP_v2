import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cashPositionWidget } from '@/server/services/reports/dashboard';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const widget = await cashPositionWidget(db);
    return NextResponse.json({
      cashAccountCode: widget.cashAccountCode,
      glBalance: widget.glBalance.toString(),
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
