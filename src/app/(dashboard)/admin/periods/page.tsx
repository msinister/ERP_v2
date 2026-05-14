import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listPeriods } from '@/server/services/fiscalPeriods';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatStatusLabel } from '@/lib/format';
import { PeriodRowActions } from './_components/period-row-actions';

export const revalidate = 0;

export default async function AdminPeriodsPage() {
  const me = await getCurrentUser();
  if (!me?.isSuperAdmin) redirect('/dashboard');

  // Periods auto-create when JEs post against a new month; the admin
  // list shows everything that exists. Sorted newest-first by the
  // service.
  const periods = await listPeriods(db, { take: 500 });

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
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Fiscal periods
          </h1>
          <p className="text-sm text-muted-foreground">
            Monthly GL periods. They auto-create when a JE first posts
            into a new month — no manual create. Soft close marks the
            month for normal users; hard close runs reconciliation
            checks and locks the period (override requires a reason).
            Reopen flips back to OPEN.
          </p>
        </div>
      </div>

      {periods.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No periods yet — they appear here once the first JE posts.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Period</TableHead>
                <TableHead>Range</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Reopened</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono">{p.code}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(p.startDate)} –{' '}
                    {/* endDate is exclusive; show the last day inclusive
                        for readability. */}
                    {formatDate(new Date(p.endDate.getTime() - 86_400_000))}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.closedAt ? formatDateTime(p.closedAt) : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.reopenedAt ? formatDateTime(p.reopenedAt) : '—'}
                  </TableCell>
                  <TableCell>
                    <PeriodRowActions
                      periodId={p.id}
                      periodCode={p.code}
                      status={p.status}
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

function StatusBadge({ status }: { status: string }) {
  const label = formatStatusLabel(status);
  if (status === 'OPEN') return <Badge variant="secondary">{label}</Badge>;
  if (status === 'HARD_CLOSED') {
    return (
      <Badge variant="outline" className="text-destructive">
        {label}
      </Badge>
    );
  }
  // SOFT_CLOSED — informational but not blocking.
  return <Badge variant="outline">{label}</Badge>;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
