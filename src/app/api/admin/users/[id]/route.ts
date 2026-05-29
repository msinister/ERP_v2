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
  linkUserToExistingRep,
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
  // Sales-rep linkage. action discriminates the four paths:
  //   'none'   → unlink (or no-op if not linked)
  //   'link'   → attach to / switch to an existing unlinked rep (repId)
  //   'create' → create a new rep (code + commission) and link it
  //   'keep'   → keep the current link, updating its commission fields
  salesRep: z
    .object({
      action: z.enum(['none', 'link', 'create', 'keep']),
      repId: z.string().min(1).optional(),
      // Explicit rep code for the 'create' path. Ignored on link/keep.
      code: z.string().min(1).max(64).optional(),
      commissionEnabled: z.boolean().optional(),
      commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
      commissionPercent: decimalString
        .refine((v) => Number(v) >= 0, 'Must be >= 0')
        .nullable()
        .optional(),
    })
    .refine((d) => d.action !== 'link' || !!d.repId, {
      message: 'repId is required to link an existing sales rep',
      path: ['repId'],
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

    // Validate a sales-rep link target up front too — the link runs after the
    // core update, so catching a bad target here avoids a partial commit.
    if (parsed.data.salesRep?.action === 'link') {
      const rep = await db.salesRep.findFirst({
        where: { id: parsed.data.salesRep.repId, deletedAt: null },
        select: { id: true, user: { select: { id: true } } },
      });
      if (!rep) {
        return NextResponse.json(
          { error: 'Sales rep not found' },
          { status: 400 },
        );
      }
      if (rep.user && rep.user.id !== id) {
        return NextResponse.json(
          { error: 'That sales rep is already linked to another user' },
          { status: 409 },
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
      const sr = parsed.data.salesRep;
      if (sr.action === 'none') {
        const res = await unlinkUserSalesRep(db, id, auditCtx);
        if (res.assignedCustomerCount > 0) {
          unlinkWarning = { assignedCustomerCount: res.assignedCustomerCount };
        }
      } else if (sr.action === 'link') {
        await linkUserToExistingRep(db, id, sr.repId!, auditCtx);
      } else if (sr.action === 'create') {
        // Creating a brand-new rep with an explicit code? Pre-check it so a
        // collision returns a clean 409 rather than an opaque unique error.
        if (sr.code && !before.salesRepId) {
          const existingRep = await db.salesRep.findUnique({
            where: { code: sr.code.trim().toUpperCase() },
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
            code: sr.code,
            commissionEnabled: sr.commissionEnabled,
            commissionBasis: sr.commissionBasis,
            commissionPercent: sr.commissionPercent,
          },
          auditCtx,
        );
      } else {
        // 'keep' — leave the link, update the linked rep's commission fields.
        await linkUserAsSalesRep(
          db,
          id,
          {
            commissionEnabled: sr.commissionEnabled,
            commissionBasis: sr.commissionBasis,
            commissionPercent: sr.commissionPercent,
          },
          auditCtx,
        );
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
