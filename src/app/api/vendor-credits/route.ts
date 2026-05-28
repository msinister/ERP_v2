import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { VendorCreditStatus } from '@/generated/tenant';
import { createVendorCreditInputSchema } from '@/lib/validation/ap';
import {
  createVendorCreditDraft,
  listVendorCreditsPaged,
} from '@/server/services/vendorCredits';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'bills.view');
    const url = new URL(req.url);
    const vendorId = url.searchParams.get('vendorId') ?? undefined;
    const statusParam = url.searchParams.get('status');
    const status =
      statusParam && statusParam in VendorCreditStatus
        ? (statusParam as VendorCreditStatus)
        : undefined;
    const q = url.searchParams.get('q') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(
      Number(url.searchParams.get('take') ?? '100') || 100,
      500,
    );
    // Paged shape `{ rows, total }`. The old raw-array shape had no
    // GUI consumer outside this route, so widening is safe.
    const page = await listVendorCreditsPaged(db, {
      vendorId,
      status,
      q,
      skip,
      take,
    });
    return NextResponse.json(page);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission(req, 'bills.create');
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createVendorCreditInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const vc = await createVendorCreditDraft(db, parsed.data, auditCtx);
    return NextResponse.json(vc, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
