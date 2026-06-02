'use client';

import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { ChangelogEntryType } from '@/generated/tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Entry = {
  id: string;
  version: string;
  title: string;
  descriptionHtml: string; // pre-rendered server-side
  type: ChangelogEntryType;
  publishedAt: string;
  isRead: boolean;
};

const TYPE_STYLE: Record<ChangelogEntryType, { label: string; className: string }> = {
  FEATURE: { label: 'Feature', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  IMPROVEMENT: { label: 'Improvement', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  BUGFIX: { label: 'Bug fix', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  SECURITY: { label: 'Security', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
};

export function WhatsNewCard({ entries }: { entries: Entry[] }) {
  // Mark all as read on mount — fire and forget
  useEffect(() => {
    const unread = entries.filter((e) => !e.isRead).map((e) => e.id);
    if (unread.length === 0) return;
    fetch('/api/changelog/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: unread }),
    }).catch(() => {/* non-critical */});
  }, [entries]);

  const hasUnread = entries.some((e) => !e.isRead);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>What&rsquo;s New</CardTitle>
          {hasUnread && (
            <span className="size-2 rounded-full bg-destructive" aria-label="Unread updates" />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Sparkles className="size-4" />
            All caught up!
          </div>
        ) : (
          <div className="space-y-6">
            {entries.map((entry) => {
              const ts = TYPE_STYLE[entry.type];
              return (
                <div key={entry.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      v{entry.version}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${ts.className}`}
                    >
                      {ts.label}
                    </span>
                    {!entry.isRead && (
                      <span className="size-1.5 rounded-full bg-destructive" aria-label="Unread" />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.publishedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="font-medium">{entry.title}</p>
                  <div
                    className="prose prose-sm text-sm text-muted-foreground"
                    dangerouslySetInnerHTML={{ __html: entry.descriptionHtml }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
