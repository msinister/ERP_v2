'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  RowDetailDialog,
  type AuditRowDetail,
} from './row-detail-dialog';

export type AuditRowData = AuditRowDetail;

// Client component so the row click can open the JSON dialog. The
// rows themselves are passed in fully resolved by the server page —
// only the dialog state lives here.
export function AuditLogTable({ rows }: { rows: AuditRowData[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AuditRowDetail | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No audit entries match these filters.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>When</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => {
                  setSelected(row);
                  setOpen(true);
                }}
              >
                <TableCell className="text-xs text-muted-foreground">
                  {formatTimestamp(row.createdAt)}
                </TableCell>
                <TableCell>
                  {row.userName || row.userEmail ? (
                    <div className="flex flex-col text-sm leading-tight">
                      <span className="font-medium">{row.userName ?? '—'}</span>
                      {row.userEmail ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {row.userEmail}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">System</span>
                  )}
                </TableCell>
                <TableCell>
                  <ActionBadge action={row.action} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col text-xs leading-tight">
                    <span className="font-medium">{row.entityType}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.entityId.length > 12
                        ? `${row.entityId.slice(0, 8)}…${row.entityId.slice(-4)}`
                        : row.entityId}
                    </span>
                  </div>
                </TableCell>
                <TableCell
                  className="max-w-[20ch] truncate text-xs text-muted-foreground"
                  title={row.reason ?? undefined}
                >
                  {row.reason ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.ipAddress ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RowDetailDialog
        row={selected}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function ActionBadge({ action }: { action: string }) {
  const label = formatAction(action);
  // Destructive actions get an outline-muted treatment to draw
  // attention; routine CREATE/UPDATE/LOGIN get plain outline.
  if (
    action === 'DELETE' ||
    action === 'VOID' ||
    action === 'REVERSE' ||
    action === 'PAYMENT_REVERSED' ||
    action === 'BILL_PAYMENT_REVERSED'
  ) {
    return (
      <Badge variant="outline" className="text-destructive">
        {label}
      </Badge>
    );
  }
  if (action === 'SENSITIVE_READ') {
    return (
      <Badge variant="outline" className="text-amber-700">
        {label}
      </Badge>
    );
  }
  if (action === 'PERMISSION_CHANGE') {
    return <Badge variant="secondary">{label}</Badge>;
  }
  return <Badge variant="outline">{label}</Badge>;
}

function formatAction(value: string): string {
  return value
    .split('_')
    .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
    .join(' ');
}

function formatTimestamp(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
