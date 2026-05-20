import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { createRole, listRoles } from '@/server/services/roles';
import { createRoleInputSchema } from '@/lib/validation/roles';

// Custom roles are Super-Admin-managed (docs/09-admin.md). All mutations
// flow through the role service, which sanitizes permissions against the
// catalog and writes PERMISSION_CHANGE audit rows.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const rows = await listRoles(db);
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
    const parsed = createRoleInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const role = await createRole(db, parsed.data, auditCtx);
    return NextResponse.json(role, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    const msg = e instanceof Error ? e.message : 'internal';
    // Unique violation on Role.name surfaces as a friendly 409.
    if (/unique|exists|duplicate/i.test(msg)) {
      return NextResponse.json(
        { error: 'A role with this name already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
