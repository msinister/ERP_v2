import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { decimalString } from '@/lib/validation/common';
import {
  getRestockingFeeDefault,
  setRestockingFeeDefault,
} from '@/server/services/restockingFee';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// HTTP body shape — accepts strings/numbers/null for percent and flat.
// The service layer normalizes to on-disk strings and validates the
// XOR + range invariants via the registered Zod schema.
const putBodySchema = z.object({
  percent: z.union([decimalString, z.null()]).optional(),
  flat: z.union([decimalString, z.null()]).optional(),
});

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const value = await getRestockingFeeDefault(db);
    return NextResponse.json({
      percent: value.percent != null ? value.percent.toString() : null,
      flat: value.flat != null ? value.flat.toString() : null,
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

export async function PUT(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = putBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const value = await setRestockingFeeDefault(db, parsed.data, auditCtx);
    return NextResponse.json({
      percent: value.percent != null ? value.percent.toString() : null,
      flat: value.flat != null ? value.flat.toString() : null,
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
