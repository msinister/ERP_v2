import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { RoleForm } from '../_components/role-form';

export const revalidate = 0;

export default async function NewRolePage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

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
          <h1 className="text-2xl font-semibold tracking-tight">New role</h1>
          <p className="text-sm text-muted-foreground">
            Name the role and check the permissions it grants.
          </p>
        </div>
      </div>

      <RoleForm mode={{ kind: 'create' }} />
    </div>
  );
}
