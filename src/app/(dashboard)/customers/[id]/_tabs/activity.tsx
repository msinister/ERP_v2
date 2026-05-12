import { db } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { listActivity } from '@/server/services/customerActivities';
import { TabShell, TabEmpty } from './tab-shell';

// Each entry renders as a timeline row: timestamp + kind badge +
// summary + optional structured detail (for AUTO entries that record
// a field change with { field, from, to }).

export async function ActivityTab({ customerId }: { customerId: string }) {
  const entries = await listActivity(db, customerId, { take: 100 });

  if (entries.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No activity yet." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <ol className="space-y-3">
        {entries.map((e) => {
          const detail = parseFieldChange(e.detailJson);
          return (
            <li
              key={e.id}
              className="flex gap-3 rounded-lg border border-border p-3 text-sm"
            >
              <div className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatTimestamp(e.createdAt)}
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={e.kind === 'AUTO' ? 'outline' : 'secondary'}
                    className="text-[10px] uppercase"
                  >
                    {e.kind}
                  </Badge>
                  <span className="font-medium">
                    {humanizeSummary(e.summary)}
                  </span>
                </div>
                {detail ? (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{detail.field}</span>:{' '}
                    <span className="line-through">{stringify(detail.from)}</span>{' '}
                    → <span className="text-foreground">{stringify(detail.to)}</span>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </TabShell>
  );
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

function humanizeSummary(s: string): string {
  // service writes things like 'creditLimit_changed' / 'customer_created'
  if (s === 'customer_created') return 'Customer created';
  if (s.endsWith('_changed')) {
    const field = s.slice(0, -'_changed'.length);
    return `${field} changed`;
  }
  return s;
}

type FieldChange = { field: string; from: unknown; to: unknown };

function parseFieldChange(json: unknown): FieldChange | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.field !== 'string') return null;
  return { field: obj.field, from: obj.from, to: obj.to };
}

function stringify(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}
