import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { UserForm } from '../_components/user-form';

export const revalidate = 0;

export default async function NewUserPage() {
  await requirePagePermission('admin.edit_users');

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
          <h1 className="text-2xl font-semibold tracking-tight">New user</h1>
          <p className="text-sm text-muted-foreground">
            Creates the account via BetterAuth (writes the password hash
            and the User row in one tx) and writes a CREATE audit row.
          </p>
        </div>
      </div>

      <UserForm mode={{ kind: 'create' }} />
    </div>
  );
}
