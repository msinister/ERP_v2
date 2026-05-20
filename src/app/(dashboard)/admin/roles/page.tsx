import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listRoles } from '@/server/services/roles';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const revalidate = 0;

export default async function RolesPage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const roles = await listRoles(db);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
          <p className="text-sm text-muted-foreground">
            Custom permission bundles. Super admins bypass roles entirely.
          </p>
        </div>
        <Button render={<Link href="/admin/roles/new" />}>
          <Plus />
          New role
        </Button>
      </div>

      {roles.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No roles yet. Create one to grant granular, non-super-admin access.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Permissions</TableHead>
                <TableHead className="text-right">Users</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r) => (
                <TableRow key={r.id} className="cursor-pointer">
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/roles/${r.id}/edit`}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.description ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.permissionCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.userCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
