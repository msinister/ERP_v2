import { AuditAction, Prisma } from '@/generated/tenant';
import type { PrismaClient, Role } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  countGranted,
  sanitizePermissionMap,
  type PermissionMap,
} from '@/lib/permissions/constants';
import {
  createRoleInputSchema,
  updateRoleInputSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from '@/lib/validation/roles';

// Custom-role service. Roles are Super-Admin-managed (docs/09-admin.md →
// People → Roles). Mutations write PERMISSION_CHANGE audit rows since a
// role IS a permission definition. Permissions are sanitized against the
// catalog before persistence — unknown keys never land in the DB.

export type RoleListRow = {
  id: string;
  name: string;
  description: string | null;
  permissionCount: number;
  userCount: number;
  permissions: PermissionMap;
};

export async function createRole(
  db: PrismaClient,
  input: CreateRoleInput,
  ctx?: AuditContext,
): Promise<Role> {
  const data = createRoleInputSchema.parse(input);
  const permissions = sanitizePermissionMap(data.permissions ?? {});
  return db.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        permissions: permissions as Prisma.InputJsonValue,
      },
    });
    await audit(tx, {
      action: AuditAction.PERMISSION_CHANGE,
      entityType: 'Role',
      entityId: role.id,
      after: { name: role.name, permissions },
      ctx,
    });
    return role;
  });
}

export async function updateRole(
  db: PrismaClient,
  id: string,
  input: UpdateRoleInput,
  ctx?: AuditContext,
): Promise<Role> {
  const data = updateRoleInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.role.findUnique({ where: { id } });
    if (!before) throw new Error(`Role not found: ${id}`);
    if (before.deletedAt) throw new Error('Role is soft-deleted');

    const updateData: Prisma.RoleUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if ('description' in data) updateData.description = data.description ?? null;
    if (data.permissions !== undefined) {
      updateData.permissions = sanitizePermissionMap(
        data.permissions,
      ) as Prisma.InputJsonValue;
    }

    const after = await tx.role.update({ where: { id }, data: updateData });
    await audit(tx, {
      action: AuditAction.PERMISSION_CHANGE,
      entityType: 'Role',
      entityId: id,
      before: {
        name: before.name,
        permissions: sanitizePermissionMap(before.permissions),
      },
      after: {
        name: after.name,
        permissions: sanitizePermissionMap(after.permissions),
      },
      ctx,
    });
    return after;
  });
}

/**
 * Soft-delete a role. Refuses while any non-deleted User still references
 * it — reassign those users first (mirrors the SalesRep / Customer delete
 * guards).
 */
export async function softDeleteRole(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<Role> {
  return db.$transaction(async (tx) => {
    const before = await tx.role.findUnique({ where: { id } });
    if (!before) throw new Error(`Role not found: ${id}`);
    if (before.deletedAt) throw new Error('Role is already soft-deleted');

    const liveRefCount = await tx.user.count({
      where: { roleId: id, deletedAt: null },
    });
    if (liveRefCount > 0) {
      throw new Error(
        `Cannot delete role: ${liveRefCount} user(s) still assigned; reassign them first`,
      );
    }

    const after = await tx.role.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.PERMISSION_CHANGE,
      entityType: 'Role',
      entityId: id,
      before: { name: before.name },
      after: { deleted: true },
      ctx,
    });
    return after;
  });
}

export async function getRole(
  db: PrismaClient,
  id: string,
): Promise<Role | null> {
  return db.role.findFirst({ where: { id, deletedAt: null } });
}

export async function listRoles(db: PrismaClient): Promise<RoleListRow[]> {
  const roles = await db.role.findMany({
    where: { deletedAt: null },
    include: { _count: { select: { users: true } } },
    orderBy: { name: 'asc' },
  });
  return roles.map((r) => {
    const permissions = sanitizePermissionMap(r.permissions);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      permissionCount: countGranted(permissions),
      userCount: r._count.users,
      permissions,
    };
  });
}
