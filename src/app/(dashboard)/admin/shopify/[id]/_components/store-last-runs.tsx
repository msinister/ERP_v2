import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type {
  StoredSyncRun,
  StoredPushRun,
  StoredOrderSyncRun,
} from '@/server/services/shopifyStores';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// Three stacked panels — last full sync, last inventory push, last
// order sync. Server components: pure render of the JSON stored on the
// ShopifyStore row.

export function StoreLastRuns({
  sync,
  push,
  orderSync,
}: {
  sync: StoredSyncRun | null;
  push: StoredPushRun | null;
  orderSync: StoredOrderSyncRun | null;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Last full sync</CardTitle>
        </CardHeader>
        <CardContent>
          <SyncSummary run={sync} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Last inventory push</CardTitle>
        </CardHeader>
        <CardContent>
          <PushSummary run={push} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Last order sync</CardTitle>
        </CardHeader>
        <CardContent>
          <OrderSyncSummary run={orderSync} />
        </CardContent>
      </Card>
    </div>
  );
}

function OrderSyncSummary({ run }: { run: StoredOrderSyncRun | null }) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No order sync has run yet for this store.
      </div>
    );
  }
  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(run.finishedAt);
  const durationSec = Math.max(
    1,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const hasErrors = run.errors.length > 0;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {startedAt.toLocaleString()} · {durationSec}s
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Imported" value={run.imported} />
        <Stat label="Skipped" value={run.skipped} muted />
        <Stat
          label="Pending review"
          value={run.pendingReview}
          tone={run.pendingReview > 0 ? 'destructive' : 'ok'}
        />
        <Stat
          label="Errors"
          value={run.errors.length}
          tone={hasErrors ? 'destructive' : 'ok'}
        />
      </div>
      {hasErrors ? (
        <ErrorList
          items={run.errors.slice(0, 8).map((e) => ({
            head: `${e.shopifyOrderNumber} (${e.shopifyOrderId})`,
            tail: e.message,
          }))}
          more={run.errors.length - 8}
        />
      ) : (
        <NoErrors />
      )}
    </div>
  );
}

function SyncSummary({ run }: { run: StoredSyncRun | null }) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No sync has run yet for this store.
      </div>
    );
  }
  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(run.finishedAt);
  const durationSec = Math.max(
    1,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const hasErrors = run.errors.length > 0;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {startedAt.toLocaleString()} · {durationSec}s
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
        <ErrorList
          items={run.errors.slice(0, 8).map((e) => ({
            head: e.shopifyId,
            tail: e.message,
          }))}
          more={run.errors.length - 8}
        />
      ) : (
        <NoErrors />
      )}
    </div>
  );
}

function PushSummary({ run }: { run: StoredPushRun | null }) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No inventory push has run yet for this store.
      </div>
    );
  }
  const startedAt = new Date(run.startedAt);
  const finishedAt = new Date(run.finishedAt);
  const durationSec = Math.max(
    1,
    Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const hasErrors = run.errors.length > 0;

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {startedAt.toLocaleString()} · {durationSec}s
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Pushed" value={run.pushed} />
        <Stat label="Skipped" value={run.skipped} muted />
        <Stat
          label="Errors"
          value={run.errors.length}
          tone={hasErrors ? 'destructive' : 'ok'}
        />
      </div>
      {hasErrors ? (
        <ErrorList
          items={run.errors.slice(0, 8).map((e) => ({
            head: e.productId,
            tail: e.message,
          }))}
          more={run.errors.length - 8}
        />
      ) : (
        <NoErrors />
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
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${colorClass}`}>
        {value}
      </div>
    </div>
  );
}

function ErrorList({
  items,
  more,
}: {
  items: Array<{ head: string; tail: string }>;
  more: number;
}) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="size-3.5" />
        Errors
      </div>
      <ul className="space-y-1 text-muted-foreground">
        {items.map((e, i) => (
          <li key={i}>
            <span className="font-mono text-foreground">{e.head}</span> —{' '}
            {e.tail}
          </li>
        ))}
        {more > 0 ? (
          <li className="italic">…and {more} more (check server logs).</li>
        ) : null}
      </ul>
    </div>
  );
}

function NoErrors() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="size-3.5" />
      No errors.
    </div>
  );
}
