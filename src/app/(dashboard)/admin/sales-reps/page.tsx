import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listSalesRepsForAdmin } from '@/server/services/salesReps';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const revalidate = 0;

export default async function SalesRepsPage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  const reps = await listSalesRepsForAdmin(db);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sales reps</h1>
          <p className="text-sm text-muted-foreground">
            Commission rate + basis live here; link a rep to a login from the
            user’s edit page.
          </p>
        </div>
        <Button render={<Link href="/admin/sales-reps/new" />}>
          <Plus />
          New sales rep
        </Button>
      </div>

      {reps.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No sales reps yet.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead>Basis</TableHead>
                <TableHead>Linked user</TableHead>
                <TableHead className="text-right">Customers</TableHead>
                <TableHead>Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reps.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/sales-reps/${r.id}/edit`}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.email ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.commissionEnabled && r.commissionPercent != null
                      ? `${r.commissionPercent}%`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.commissionEnabled
                      ? r.commissionBasis === 'MARGIN'
                        ? 'Margin'
                        : 'Revenue'
                      : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.linkedUser ? r.linkedUser.email : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.assignedCustomerCount}
                  </TableCell>
                  <TableCell>
                    {r.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline">Inactive</Badge>
                    )}
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
