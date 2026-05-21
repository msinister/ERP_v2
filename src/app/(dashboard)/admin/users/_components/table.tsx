import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export type UserRowData = {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  // Assigned custom-role name, or null when none. Super Admins bypass
  // roles, so this is null for them and the column shows the Super badge.
  roleName: string | null;
  enabled: boolean;
  forcePasswordReset: boolean;
  lastLoginAt: Date | null;
};

export function UsersTable({ rows }: { rows: UserRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No users match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last login</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-medium">
                <Link
                  href={`/admin/users/${row.id}/edit`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">Edit {row.name}</span>
                </Link>
                {row.name}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {row.email}
              </TableCell>
              <TableCell>
                {row.isSuperAdmin ? (
                  <Badge>Super admin</Badge>
                ) : row.roleName ? (
                  <Badge variant="outline">{row.roleName}</Badge>
                ) : (
                  <span className="text-sm text-muted-foreground">No role</span>
                )}
              </TableCell>
              <TableCell className="space-x-1">
                {row.enabled ? (
                  <Badge variant="secondary">Enabled</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Disabled
                  </Badge>
                )}
                {row.forcePasswordReset ? (
                  <Badge variant="outline" className="text-amber-700">
                    Password reset
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.lastLoginAt
                  ? row.lastLoginAt.toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'Never'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
