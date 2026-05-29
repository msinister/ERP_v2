import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuditAction, Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit/audit';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { decimalString } from '@/lib/validation/common';
import {
  linkUserAsSalesRep,
  unlinkUserSalesRep,
} from '@/server/services/salesReps';

// Admin user-update endpoint. Covers the fields a super-admin can flip:
//   - name           (display name; email is immutable)
//   - enabled        (block login without losing audit trail)
//   - isSuperAdmin   (role flip — PERMISSION_CHANGE audit row)
//   - forcePasswordReset (flag the user to rotate on next login)
//   - roleId         (custom-role assignment; null = unassign)
//   - salesRep       (flag/unflag as sales rep + commission fields; the
//                     link is owned by User.salesRepId → a SalesRep row,
//                     created on demand — see linkUserAsSalesRep)
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
  // null = unassign role. Absent = leave unchanged.
  roleId: z.string().min(1).nullable().optional(),
  salesRep: z
    .object({
      isSalesRep: z.boolean(),
      // Explicit rep code for the "create as sales rep" path when the user
      // isn't linked yet. Ignored once linked (the rep owns its code).
      code: z.string().min(1).max(64).optional(),
      commissionEnabled: z.boolean().optional(),
      commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
      commissionPercent: decimalString
        .refine((v) => Number(v) >= 0, 'Must be >= 0')
        .nullable()
        .optional(),
    })
    .optional(),
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
        roleId: true,
        salesRepId: true,
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

    // Validate role assignment up front — connecting to a missing/deleted
    // role would otherwise throw an opaque FK error.
    if (parsed.data.roleId) {
      const role = await db.role.findFirst({
        where: { id: parsed.data.roleId, deletedAt: null },
        select: { id: true },
      });
      if (!role) {
        return NextResponse.json({ error: 'Role not found' }, { status: 400 });
      }
    }

    const data: Prisma.UserUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.isSuperAdmin !== undefined)
      data.isSuperAdmin = parsed.data.isSuperAdmin;
    if (parsed.data.forcePasswordReset !== undefined)
      data.forcePasswordReset = parsed.data.forcePasswordReset;
    if ('roleId' in parsed.data) {
      data.role = parsed.data.roleId
        ? { connect: { id: parsed.data.roleId } }
        : { disconnect: true };
    }

    const hasCoreChange = Object.keys(data).length > 0;
    const hasSalesRepChange = parsed.data.salesRep !== undefined;
    if (!hasCoreChange && !hasSalesRepChange) {
      return NextResponse.json(before);
    }

    if (hasCoreChange) {
      await db.user.update({ where: { id }, data });
    }

    // Sales-rep link/unlink runs in its own transaction (creates/updates a
    // SalesRep + flips User.salesRepId) and writes its own audit rows.
    // Unlink warns-not-blocks when the rep still owns customers.
    let unlinkWarning: { assignedCustomerCount: number } | null = null;
    if (parsed.data.salesRep) {
      if (parsed.data.salesRep.isSalesRep) {
        // Creating a brand-new rep with an explicit code? Pre-check it so a
        // collision returns a clean 409 rather than an opaque unique error.
        if (parsed.data.salesRep.code && !before.salesRepId) {
          const existingRep = await db.salesRep.findUnique({
            where: { code: parsed.data.salesRep.code.trim().toUpperCase() },
            select: { id: true },
          });
          if (existingRep) {
            return NextResponse.json(
              { error: 'A sales rep with this code already exists' },
              { status: 409 },
            );
          }
        }
        await linkUserAsSalesRep(
          db,
          id,
          {
            code: parsed.data.salesRep.code,
            commissionEnabled: parsed.data.salesRep.commissionEnabled,
            commissionBasis: parsed.data.salesRep.commissionBasis,
            commissionPercent: parsed.data.salesRep.commissionPercent,
          },
          auditCtx,
        );
      } else {
        const res = await unlinkUserSalesRep(db, id, auditCtx);
        if (res.assignedCustomerCount > 0) {
          unlinkWarning = { assignedCustomerCount: res.assignedCustomerCount };
        }
      }
    }

    const after = await db.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
        roleId: true,
        salesRepId: true,
      },
    });

    // PERMISSION_CHANGE when access-defining fields move (super-admin,
    // enabled, role); UPDATE otherwise. Sales-rep linkage already audited
    // itself in the service, so only the core update writes a row here.
    if (hasCoreChange) {
      const isPermissionChange =
        (parsed.data.isSuperAdmin !== undefined &&
          parsed.data.isSuperAdmin !== before.isSuperAdmin) ||
        (parsed.data.enabled !== undefined &&
          parsed.data.enabled !== before.enabled) ||
        after.roleId !== before.roleId;
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
          roleId: before.roleId,
        },
        after: {
          name: after.name,
          isSuperAdmin: after.isSuperAdmin,
          enabled: after.enabled,
          forcePasswordReset: after.forcePasswordReset,
          roleId: after.roleId,
        },
        ctx: auditCtx,
      });
    }

    return NextResponse.json({
      ...after,
      ...(unlinkWarning ? { unlinkWarning } : {}),
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
