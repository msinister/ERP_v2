import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { postAccountTransferInputSchema } from '@/lib/validation/accountTransfers';
import { postAccountTransfer } from '@/server/services/accountTransfers';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// POST /api/transfers — post a balanced account-transfer JE
// (DR to / CR from) between two ASSET/LIABILITY GL accounts.
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
    const parsed = postAccountTransferInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const je = await postAccountTransfer(db, parsed.data, auditCtx);
    return NextResponse.json(
      { id: je.id, number: je.number },
      { status: 201 },
    );
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
