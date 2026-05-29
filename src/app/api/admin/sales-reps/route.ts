import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import {
  createSalesRep,
  findRepByEmail,
  listSalesRepsForAdmin,
} from '@/server/services/salesReps';
import { createSalesRepInputSchema } from '@/lib/validation/salesReps';

// Sales reps are People-admin master data (docs/09-admin.md). Managed by
// Super Admin. Commission fields live on SalesRep where the commission
// engine reads them.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const url = new URL(req.url);
    // Duplicate-email check used by the create/edit forms (warn, don't
    // block). Returns just the matching rep when `email` is supplied.
    const email = url.searchParams.get('email');
    if (email !== null) {
      const exclude = url.searchParams.get('exclude') ?? undefined;
      const duplicate = await findRepByEmail(db, email, exclude);
      return NextResponse.json({ duplicate });
    }
    const rows = await listSalesRepsForAdmin(db);
    return NextResponse.json({ rows });
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
    const actor = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, actor);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createSalesRepInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const rep = await createSalesRep(db, parsed.data, auditCtx);
    return NextResponse.json(rep, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    const msg = e instanceof Error ? e.message : 'internal';
    if (/unique|exists|duplicate/i.test(msg)) {
      return NextResponse.json(
        { error: 'A sales rep with this code already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
