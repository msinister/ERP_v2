'use client';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type AuditRowDetail = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userName: string | null;
  userEmail: string | null;
  ipAddress: string | null;
  reason: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: Date;
};

export function RowDetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: AuditRowDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Audit entry</AlertDialogTitle>
          <AlertDialogDescription>
            {row
              ? `${row.entityType} · ${formatAction(row.action)}`
              : 'No row selected.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {row ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                When
              </dt>
              <dd className="col-span-2">{formatTimestamp(row.createdAt)}</dd>

              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                User
              </dt>
              <dd className="col-span-2">
                {row.userName || row.userEmail ? (
                  <>
                    {row.userName ?? '—'}
                    {row.userEmail ? (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {row.userEmail}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">System</span>
                )}
              </dd>

              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Entity
              </dt>
              <dd className="col-span-2 font-mono text-xs">
                {row.entityType} · {row.entityId}
              </dd>

              {row.ipAddress ? (
                <>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    IP
                  </dt>
                  <dd className="col-span-2 font-mono text-xs">{row.ipAddress}</dd>
                </>
              ) : null}

              {row.reason ? (
                <>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Reason
                  </dt>
                  <dd className="col-span-2 whitespace-pre-line">{row.reason}</dd>
                </>
              ) : null}
            </dl>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <JsonPanel label="Before" value={row.beforeJson} />
              <JsonPanel label="After" value={row.afterJson} />
            </div>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function JsonPanel({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {value == null ? (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          —
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-snug">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
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
    second: '2-digit',
    timeZone: 'UTC',
  });
}
