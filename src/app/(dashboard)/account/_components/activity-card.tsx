'use client';

import { ClipboardList } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatStatusLabel } from '@/lib/format';

type ActivityEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  ipAddress: string | null;
};

function actionLabel(action: string, entityType: string): string {
  const type = entityType.replace(/([A-Z])/g, ' $1').trim();
  switch (action) {
    case 'CREATE': return `Created ${type}`;
    case 'UPDATE': return `Updated ${type}`;
    case 'DELETE': return `Deleted ${type}`;
    case 'STATUS_CHANGE': return `Status change on ${type}`;
    case 'LOGIN': return 'Signed in';
    case 'LOGOUT': return 'Signed out';
    case 'PERMISSION_CHANGE': return 'Permission change';
    default: return `${formatStatusLabel(action)} ${type}`;
  }
}

export function ActivityCard({ entries }: { entries: ActivityEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>My Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ClipboardList className="size-4" />
            No recent activity.
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div
                key={e.id}
                className="flex items-start justify-between gap-3 py-1 text-sm"
              >
                <span className="text-foreground/80">
                  {actionLabel(e.action, e.entityType)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
