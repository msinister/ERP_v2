import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import {
  UserForm,
  type UserFormValues,
} from '../../_components/user-form';

export const revalidate = 0;

export default async function EditUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requirePagePermission('admin.edit_users');

  const { id } = await params;
  const [user, roles] = await Promise.all([
    db.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
        roleId: true,
        salesRep: {
          select: {
            id: true,
            code: true,
            name: true,
            commissionEnabled: true,
            commissionBasis: true,
            commissionPercent: true,
          },
        },
      },
    }),
    db.role.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  if (!user) notFound();

  // Omit roleId / sales-rep keys when absent so the form's defaults
  // ("__none__" role, not-a-sales-rep) apply cleanly.
  const defaults: Partial<UserFormValues> = {
    name: user.name,
    email: user.email,
    password: '',
    enabled: user.enabled,
    isSuperAdmin: user.isSuperAdmin,
    forcePasswordReset: user.forcePasswordReset,
  };
  if (user.roleId) defaults.roleId = user.roleId;
  if (user.salesRep) {
    defaults.isSalesRep = true;
    defaults.salesRepCode = user.salesRep.code;
    defaults.commissionEnabled = user.salesRep.commissionEnabled;
    defaults.commissionBasis = user.salesRep.commissionBasis ?? 'REVENUE';
    defaults.commissionPercent =
      user.salesRep.commissionPercent?.toString() ?? '';
  }
  const linkedRep = user.salesRep
    ? {
        id: user.salesRep.id,
        code: user.salesRep.code,
        name: user.salesRep.name,
      }
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Users
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit user</h1>
          <p className="text-sm text-muted-foreground">
            {user.name} · <span className="font-mono">{user.email}</span>
          </p>
        </div>
      </div>

      <UserForm
        mode={{ kind: 'edit', userId: user.id, isSelf: me.id === user.id }}
        defaultValues={defaults}
        roles={roles}
        linkedRep={linkedRep}
      />
    </div>
  );
}
