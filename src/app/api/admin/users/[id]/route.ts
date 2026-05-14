import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuditAction, Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit/audit';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Admin user-update endpoint. Covers the fields a super-admin can flip:
//   - name           (display name; email is immutable)
//   - enabled        (block login without losing audit trail)
//   - isSuperAdmin   (role flip — PERMISSION_CHANGE audit row)
//   - forcePasswordReset (flag the user to rotate on next login)
//
// No DELETE — users own audit-trail dependencies. Disabling is the
// supported way to revoke access.
//
// No email change either — would orphan auditLog.userId / login
// history. A future "rename email" path would need to update the
// BetterAuth account row as well; out of pilot scope.
const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  isSuperAdmin: z.boolean().optional(),
  forcePasswordReset: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, actor);
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const before = await db.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
        deletedAt: true,
      },
    });
    if (!before) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (before.deletedAt) {
      return NextResponse.json(
        { error: 'User is soft-deleted' },
        { status: 400 },
      );
    }

    // Guard: a super-admin cannot demote or disable themselves — would
    // produce a lockout if they're the only super-admin. Demote via a
    // different super-admin's session instead.
    if (actor.id === id) {
      if (parsed.data.isSuperAdmin === false) {
        return NextResponse.json(
          { error: 'You cannot demote your own super-admin status' },
          { status: 400 },
        );
      }
      if (parsed.data.enabled === false) {
        return NextResponse.json(
          { error: 'You cannot disable your own account' },
          { status: 400 },
        );
      }
    }

    const data: Prisma.UserUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.isSuperAdmin !== undefined)
      data.isSuperAdmin = parsed.data.isSuperAdmin;
    if (parsed.data.forcePasswordReset !== undefined)
      data.forcePasswordReset = parsed.data.forcePasswordReset;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(before);
    }

    const after = await db.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
      },
    });

    // PERMISSION_CHANGE for role flips, UPDATE for everything else.
    // Matches the convention used by the bootstrap script.
    const isPermissionChange =
      (parsed.data.isSuperAdmin !== undefined &&
        parsed.data.isSuperAdmin !== before.isSuperAdmin) ||
      (parsed.data.enabled !== undefined &&
        parsed.data.enabled !== before.enabled);
    await audit(db, {
      action: isPermissionChange
        ? AuditAction.PERMISSION_CHANGE
        : AuditAction.UPDATE,
      entityType: 'User',
      entityId: id,
      before: {
        name: before.name,
        isSuperAdmin: before.isSuperAdmin,
        enabled: before.enabled,
        forcePasswordReset: before.forcePasswordReset,
      },
      after: {
        name: after.name,
        isSuperAdmin: after.isSuperAdmin,
        enabled: after.enabled,
        forcePasswordReset: after.forcePasswordReset,
      },
      ctx: auditCtx,
    });

    return NextResponse.json(after);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
