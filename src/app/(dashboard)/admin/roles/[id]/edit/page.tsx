import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { getRole } from '@/server/services/roles';
import { sanitizePermissionMap } from '@/lib/permissions/constants';
import { RoleForm } from '../../_components/role-form';

export const revalidate = 0;

export default async function EditRolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const { id } = await params;
  const role = await getRole(db, id);
  if (!role) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin/roles"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Roles
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit role</h1>
          <p className="text-sm text-muted-foreground">{role.name}</p>
        </div>
      </div>

      <RoleForm
        mode={{ kind: 'edit', roleId: role.id }}
        defaults={{
          name: role.name,
          description: role.description ?? '',
          permissions: sanitizePermissionMap(role.permissions),
        }}
      />
    </div>
  );
}
