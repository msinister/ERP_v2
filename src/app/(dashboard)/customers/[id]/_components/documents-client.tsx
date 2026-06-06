'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatStatusLabel } from '@/lib/format';
import { DocumentFormDialog, type DocRow } from './document-form-dialog';
import { TabShell } from '../_tabs/tab-shell';

const SENSITIVE_KINDS = new Set(['EIN', 'SSN', 'DRIVERS_LICENSE']);
const SOON_MS = 30 * 24 * 60 * 60 * 1000;

type Props = {
  customerId: string;
  documents: DocRow[];
};

export function DocumentsClient({ customerId, documents }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DocRow | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [revealDocId, setRevealDocId] = useState<string | null>(null);
  const [revealKind, setRevealKind] = useState<string>('');

  function openUpload() {
    setEditDoc(undefined);
    setFormOpen(true);
  }

  function openEdit(doc: DocRow) {
    setEditDoc(doc);
    setFormOpen(true);
  }

  function openReveal(doc: DocRow) {
    setRevealDocId(doc.id);
    setRevealKind(doc.kind);
  }

  const now = Date.now();

  return (
    <TabShell>
      <div className="flex items-center justify-between">
        <span />
        <Button size="sm" onClick={openUpload}>
          <Plus className="size-3.5" />
          Upload document
        </Button>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No documents on file. Upload one above.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Type</TableHead>
                <TableHead>File / value</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((d) => {
                const isSensitive = SENSITIVE_KINDS.has(d.kind);
                const expMs = d.expiresOn?.getTime();
                const expiresSoon =
                  expMs != null && expMs > now && expMs - now < SOON_MS;
                const expired = expMs != null && expMs < now;

                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {formatStatusLabel(d.kind)}
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {isSensitive ? (
                        <span className="font-mono text-xs">
                          encrypted — view requires audit
                        </span>
                      ) : (
                        <span>{d.fileName ?? d.storageKey ?? '—'}</span>
                      )}
                    </TableCell>

                    <TableCell>
                      {d.expiresOn ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm tabular-nums">
                            {d.expiresOn.toLocaleDateString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              timeZone: 'UTC',
                            })}
                          </span>
                          {expired ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : expiresSoon ? (
                            <Badge variant="outline">≤ 30 d</Badge>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {d.notes ?? '—'}
                    </TableCell>

                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Document actions"
                            />
                          }
                        >
                          <MoreVertical className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isSensitive ? (
                            <DropdownMenuItem onClick={() => openReveal(d)}>
                              <Eye className="size-4" />
                              View value
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={() => openEdit(d)}>
                            <Pencil className="size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setDeleteId(d.id)}
                            variant="destructive"
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs rendered outside dropdowns to avoid unmount-on-close flash */}
      <DocumentFormDialog
        customerId={customerId}
        doc={editDoc}
        open={formOpen}
        onOpenChange={setFormOpen}
      />

      <RevealValueDialog
        customerId={customerId}
        documentId={revealDocId}
        kind={revealKind}
        open={revealDocId !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRevealDocId(null);
            setRevealKind('');
          }
        }}
      />

      <DeleteDocumentDialog
        customerId={customerId}
        documentId={deleteId}
        open={deleteId !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteId(null);
        }}
      />
    </TabShell>
  );
}

// ---------------------------------------------------------------------------
// Reveal sensitive value — fetches cleartext via the audited endpoint.
// Value is cleared from state on close; lives only in component state
// while the dialog is open, never persisted elsewhere.
// ---------------------------------------------------------------------------

function RevealValueDialog({
  customerId,
  documentId,
  kind,
  open,
  onOpenChange,
}: {
  customerId: string;
  documentId: string | null;
  kind: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Fetch on open, scrub on close — mirrors the vendor payment reveal pattern.
  useEffect(() => {
    if (!open || !documentId) {
      setValue(null);
      setFetchError(null);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/customers/${customerId}/documents/${documentId}/cleartext`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setFetchError(body.error ?? `Reveal failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { value: string };
        setValue(data.value);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'Network error');
      }
    });
  }, [open, customerId, documentId]);

  const kindLabel: Record<string, string> = {
    EIN: 'EIN',
    SSN: 'SSN',
    DRIVERS_LICENSE: "Driver's license",
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>View {kindLabel[kind] ?? kind}</AlertDialogTitle>
          <AlertDialogDescription>
            This access is recorded in the audit log as a SENSITIVE_READ event.
            Close the dialog when finished.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="min-h-[3rem] rounded-md border border-border bg-muted/30 p-3 font-mono text-sm">
          {pending && !value && !fetchError ? (
            <span className="text-muted-foreground">Decrypting…</span>
          ) : fetchError ? (
            <span className="text-destructive">{fetchError}</span>
          ) : value ? (
            <span className="select-all">{value}</span>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogAction onClick={() => onOpenChange(false)}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog
// ---------------------------------------------------------------------------

function DeleteDocumentDialog({
  customerId,
  documentId,
  open,
  onOpenChange,
}: {
  customerId: string;
  documentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!documentId) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/customers/${customerId}/documents/${documentId}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? 'Delete failed');
          return;
        }
        toast.success('Document deleted');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this document?</AlertDialogTitle>
          <AlertDialogDescription>
            The document will be removed from the customer record. This cannot
            be undone from the UI (the record is retained in the audit log).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
