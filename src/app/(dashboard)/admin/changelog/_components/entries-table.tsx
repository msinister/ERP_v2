'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { ChangelogEntryType } from '@/generated/tenant';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChangelogFormDialog, type EntryForEdit } from './changelog-form-dialog';
import { toast } from '@/lib/toast';

type Entry = {
  id: string;
  version: string;
  title: string;
  description: string;
  type: ChangelogEntryType;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { name: string; email: string } | null;
};

const TYPE_BADGE: Record<ChangelogEntryType, { label: string; className: string }> = {
  FEATURE: { label: 'Feature', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  IMPROVEMENT: { label: 'Improvement', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  BUGFIX: { label: 'Bug fix', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  SECURITY: { label: 'Security', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
};

function isPublished(publishedAt: string | null): boolean {
  if (!publishedAt) return false;
  return new Date(publishedAt) <= new Date();
}

export function EntriesTable({ initialEntries }: { initialEntries: Entry[] }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<EntryForEdit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  function openCreate() {
    setEditingEntry(null);
    setFormOpen(true);
  }

  function openEdit(entry: Entry) {
    setEditingEntry({
      id: entry.id,
      version: entry.version,
      title: entry.title,
      description: entry.description,
      type: entry.type,
      publishedAt: entry.publishedAt,
    });
    setFormOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeletePending(true);
    try {
      const res = await fetch(`/api/admin/changelog/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to delete entry');
        return;
      }
      toast.success('Entry deleted');
      setDeleteTarget(null);
      router.refresh();
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          New entry
        </Button>
      </div>

      {initialEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changelog entries yet.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {initialEntries.map((entry) => {
            const published = isPublished(entry.publishedAt);
            const tb = TYPE_BADGE[entry.type];
            return (
              <div key={entry.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      v{entry.version}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${tb.className}`}
                    >
                      {tb.label}
                    </span>
                    <Badge variant={published ? 'default' : 'secondary'} className="text-[10px] py-0">
                      {published ? 'Published' : 'Draft'}
                    </Badge>
                  </div>
                  <p className="font-medium text-sm">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.publishedAt
                      ? new Date(entry.publishedAt).toLocaleDateString()
                      : 'No publish date'}{' '}
                    · by {entry.createdBy?.name ?? entry.createdBy?.email ?? 'unknown'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openEdit(entry)}
                    aria-label="Edit"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeleteTarget(entry)}
                    aria-label="Delete"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ChangelogFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        entry={editingEntry}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete changelog entry?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.title}&rdquo; will be soft-deleted and hidden
              from users. This cannot be undone from the UI.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deletePending}>
              {deletePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
