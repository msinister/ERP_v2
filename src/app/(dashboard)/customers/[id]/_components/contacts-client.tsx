'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { ContactFormDialog, type ContactRow } from './contact-form-dialog';
import { TabShell } from '../_tabs/tab-shell';

type Props = {
  customerId: string;
  contacts: ContactRow[];
};

export function ContactsClient({ customerId, contacts }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<ContactRow | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openAdd() {
    setEditContact(undefined);
    setFormOpen(true);
  }

  function openEdit(contact: ContactRow) {
    setEditContact(contact);
    setFormOpen(true);
  }

  return (
    <TabShell>
      <div className="flex items-center justify-between">
        <span />
        <Button size="sm" onClick={openAdd}>
          <Plus className="size-3.5" />
          Add contact
        </Button>
      </div>

      {contacts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No contacts on file. Add one above.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {c.name}
                      {c.isPrimary ? (
                        <Badge variant="secondary">Primary</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.role ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.email ? (
                      <a
                        href={`mailto:${c.email}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.email}
                      </a>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.phone ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.mobile ?? '—'}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Contact actions"
                          />
                        }
                      >
                        <MoreVertical className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(c)}>
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeleteId(c.id)}
                          variant="destructive"
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs rendered outside dropdowns to avoid unmount-on-close flash */}
      <ContactFormDialog
        customerId={customerId}
        contact={editContact}
        open={formOpen}
        onOpenChange={setFormOpen}
      />

      <DeleteContactDialog
        customerId={customerId}
        contactId={deleteId}
        open={deleteId !== null}
        onOpenChange={(o) => { if (!o) setDeleteId(null); }}
      />
    </TabShell>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog
// ---------------------------------------------------------------------------

function DeleteContactDialog({
  customerId,
  contactId,
  open,
  onOpenChange,
}: {
  customerId: string;
  contactId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!contactId) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/customers/${customerId}/contacts/${contactId}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? 'Delete failed');
          return;
        }
        toast.success('Contact deleted');
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
          <AlertDialogTitle>Delete this contact?</AlertDialogTitle>
          <AlertDialogDescription>
            The contact will be removed from the customer record. This cannot
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
