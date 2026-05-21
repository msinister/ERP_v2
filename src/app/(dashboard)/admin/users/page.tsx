import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, Plus } from 'lucide-react';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { Button } from '@/components/ui/button';
import { UsersFilters } from './_components/filters';
import { UsersTable, type UserRowData } from './_components/table';
import { UsersPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const sp = await searchParams;
  const q = pickString(sp.q);
  const role = pickString(sp.role);
  const enabledRaw = pickString(sp.enabled);
  const enabled =
    enabledRaw === 'all' ? undefined : enabledRaw === 'false' ? false : true;
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(role === 'super'
      ? { isSuperAdmin: true }
      : role === 'regular'
        ? { isSuperAdmin: false }
        : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
        lastLoginAt: true,
        role: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    db.user.count({ where }),
  ]);

  const tableRows: UserRowData[] = rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    isSuperAdmin: u.isSuperAdmin,
    enabled: u.enabled,
    forcePasswordReset: u.forcePasswordReset,
    lastLoginAt: u.lastLoginAt,
    roleName: u.role?.name ?? null,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="text-sm text-muted-foreground">
              Add new users, flip roles, disable accounts, force password
              resets. Deletes are not supported — disable instead.
            </p>
          </div>
          <Button render={<Link href="/admin/users/new" />}>
            <Plus />
            New user
          </Button>
        </div>
      </div>

      <UsersFilters />

      <UsersTable rows={tableRows} />

      <UsersPagination total={total} skip={skip} take={take} />
    </div>
  );
}
