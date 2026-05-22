import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logExpenseBatchInputSchema } from '@/lib/validation/expenses';
import { logExpenseBatch } from '@/server/services/expenses';
import type { LogExpenseInput } from '@/lib/validation/expenses';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// POST /api/expenses/batch — log many expenses atomically. The shared
// paymentAccountId is merged into every row before handing off to the
// service. All-or-nothing: one bad row rolls the whole paste back.
export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = logExpenseBatchInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const inputs: LogExpenseInput[] = parsed.data.rows.map((r) => ({
      vendorName: r.vendorName,
      amount: r.amount,
      expenseAccountId: r.expenseAccountId,
      paymentAccountId: parsed.data.paymentAccountId,
      date: r.date,
      notes: r.notes,
    }));
    const results = await logExpenseBatch(db, inputs, auditCtx);
    return NextResponse.json({ results }, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
