'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { TabEmpty, TabShell } from './tab-shell';
import {
  VariantFormDialog,
  type VariantFormDialogVariant,
} from './variant-form-dialog';

export type VariantRow = VariantFormDialogVariant;

export function VariantsTab({
  productId,
  productSku,
  variants,
}: {
  productId: string;
  productSku: string;
  variants: VariantRow[];
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VariantRow | null>(null);

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(v: VariantRow) {
    setEditing(v);
    setFormOpen(true);
  }

  return (
    <TabShell>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Each variant owns its own SKU. Attributes (color / flavor / size /
          group) are free-text.
        </p>
        <Button size="sm" variant="outline" onClick={openAdd}>
          <Plus />
          Add variant
        </Button>
      </div>

      {variants.length === 0 ? (
        <TabEmpty message="No variants yet. Add one above to make the product orderable." />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>SKU</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Attributes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {v.sku}
                  </TableCell>
                  <TableCell className="font-medium">
                    {v.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <Attributes variant={v} />
                  </TableCell>
                  <TableCell>
                    {v.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${v.sku}`}
                        onClick={() => openEdit(v)}
                      >
                        <Pencil />
                      </Button>
                      <ArchiveVariantButton
                        variantId={v.id}
                        variantSku={v.sku}
                        active={v.active}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <VariantFormDialog
        productId={productId}
        productSku={productSku}
        variant={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
    </TabShell>
  );
}

function Attributes({ variant }: { variant: VariantRow }) {
  const parts: string[] = [];
  if (variant.variantGroup) parts.push(variant.variantGroup);
  if (variant.size) parts.push(variant.size);
  if (variant.color) parts.push(variant.color);
  if (variant.flavor) parts.push(variant.flavor);
  if (parts.length === 0) return <span>—</span>;
  return <span>{parts.join(' · ')}</span>;
}

function ArchiveVariantButton({
  variantId,
  variantSku,
  active,
}: {
  variantId: string;
  variantSku: string;
  active: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/variants/${variantId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Archive failed (${res.status})`);
          return;
        }
        toast.success(`Archived ${variantSku}`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  // Already archived variants can't be re-archived. Keep the button
  // hidden so the row doesn't suggest a no-op.
  if (!active) return null;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Archive ${variantSku}`}
        onClick={() => setOpen(true)}
      >
        <Archive />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this variant?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono font-medium text-foreground">
              {variantSku}
            </span>{' '}
            will be hidden from the SO picker. Existing orders that reference
            it are unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Archiving…' : 'Archive'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
