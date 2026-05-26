import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { StoredSyncRun } from '@/server/services/shopifyConfig';

// Renders the last full-sync run summary. Server component — pure
// presentation of the JSON stored alongside the config.

export function ShopifySyncLog({ run }: { run: StoredSyncRun | null }) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        No full sync has run yet.
      </div>
    );
  }
  const hasErrors = run.errors.length > 0;
  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(run.finishedAt);
  const durationSec = Math.max(
    1,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">Last sync:</span>
        <span className="text-muted-foreground">
          {startedAt.toLocaleString()} · {durationSec}s
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Created" value={run.created} />
        <Stat label="Updated" value={run.updated} />
        <Stat label="Skipped" value={run.skipped} muted />
        <Stat
          label="Errors"
          value={run.errors.length}
          tone={hasErrors ? 'destructive' : 'ok'}
        />
      </div>
      {hasErrors ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
            <AlertTriangle className="size-3.5" />
            Errors
          </div>
          <ul className="space-y-1 text-muted-foreground">
            {run.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                <span className="font-mono text-foreground">{e.shopifyId}</span>{' '}
                — {e.message}
              </li>
            ))}
            {run.errors.length > 10 ? (
              <li className="italic">
                …and {run.errors.length - 10} more (check server logs).
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-3.5" />
          No errors.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: number;
  muted?: boolean;
  tone?: 'ok' | 'destructive';
}) {
  const colorClass =
    tone === 'destructive' && value > 0
      ? 'text-destructive'
      : muted
        ? 'text-muted-foreground'
        : '';
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${colorClass}`}>
        {value}
      </div>
    </div>
  );
}
