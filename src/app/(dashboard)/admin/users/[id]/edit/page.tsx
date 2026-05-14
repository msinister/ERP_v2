import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
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
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const { id } = await params;
  const user = await db.user.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      isSuperAdmin: true,
      enabled: true,
      forcePasswordReset: true,
    },
  });
  if (!user) notFound();

  const defaults: Partial<UserFormValues> = {
    name: user.name,
    email: user.email,
    password: '',
    enabled: user.enabled,
    isSuperAdmin: user.isSuperAdmin,
    forcePasswordReset: user.forcePasswordReset,
  };

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
      />
    </div>
  );
}
