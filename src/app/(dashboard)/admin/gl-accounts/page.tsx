import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listAccounts } from '@/server/services/glAccounts';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AddAccountButton } from './_components/add-account-button';
import { AccountRowActions } from './_components/account-row-actions';

export const revalidate = 0;

export default async function AdminGlAccountsPage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  // Pilot scale: a few dozen GL accounts. One fetch covers active +
  // inactive (no `active` filter passed) so the table can show
  // archived rows with a muted status.
  const accounts = await listAccounts(db, { take: 500 });

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
            <h1 className="text-2xl font-semibold tracking-tight">
              GL accounts
            </h1>
            <p className="text-sm text-muted-foreground">
              Chart of accounts — code, name, type, active status. Code
              and type are fixed once created (services reference them
              as stable identifiers).
            </p>
          </div>
          <AddAccountButton />
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No GL accounts yet — add one to get started.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.code}</TableCell>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-muted-foreground">
                      {formatType(a.type)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {a.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <AccountRowActions
                      account={{
                        id: a.id,
                        code: a.code,
                        name: a.name,
                        type: a.type,
                        active: a.active,
                      }}
                    />
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

function formatType(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
