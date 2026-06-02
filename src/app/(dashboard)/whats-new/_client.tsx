'use client';

import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { ChangelogEntryType } from '@/generated/tenant';

type Entry = {
  id: string;
  version: string;
  title: string;
  descriptionHtml: string;
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

export function WhatsNewPage({ entries }: { entries: Entry[] }) {
  // Mark all unread entries as read on mount — fire and forget
  useEffect(() => {
    const unread = entries.filter((e) => !e.isRead).map((e) => e.id);
    if (unread.length === 0) return;
    fetch('/api/changelog/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryIds: unread }),
    }).catch(() => {/* non-critical */});
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex items-center gap-2 py-12 text-muted-foreground">
        <Sparkles className="size-5" />
        <span>No updates yet. Check back soon.</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      {entries.map((entry, idx) => {
        const ts = TYPE_STYLE[entry.type];
        const isFirst = idx === 0;
        return (
          <div key={entry.id} className="relative pl-6">
            {/* Timeline dot */}
            <div
              className={`absolute left-0 top-1.5 size-2.5 rounded-full border-2 ${
                entry.isRead
                  ? 'border-muted-foreground bg-background'
                  : 'border-destructive bg-destructive'
              }`}
            />
            {/* Timeline line (not on last item) */}
            {idx < entries.length - 1 && (
              <div className="absolute left-[4.5px] top-4 bottom-[-2rem] w-px bg-border" />
            )}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">v{entry.version}</span>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${ts.className}`}
                >
                  {ts.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.publishedAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
                {!entry.isRead && isFirst && (
                  <span className="inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                    New
                  </span>
                )}
              </div>
              <h2 className="text-base font-semibold">{entry.title}</h2>
              <div
                className="prose prose-sm text-sm text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: entry.descriptionHtml }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
