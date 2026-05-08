import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { openPosWidget } from '@/server/services/reports/dashboard';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const widget = await openPosWidget(db);
    return NextResponse.json(widget);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
