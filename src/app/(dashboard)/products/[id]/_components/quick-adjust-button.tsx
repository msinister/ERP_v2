'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { SlidersHorizontal } from 'lucide-react';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'SHORTAGE', label: 'Shortage' },
  { value: 'BREAKAGE', label: 'Breakage' },
  { value: 'MISSING', label: 'Missing' },
  { value: 'THEFT', label: 'Theft' },
  { value: 'DEFECT', label: 'Defect' },
  { value: 'REJECT', label: 'Reject' },
  { value: 'FOUND_STOCK', label: 'Found stock' },
  { value: 'CYCLE_COUNT', label: 'Cycle count' },
  { value: 'OTHER', label: 'Other' },
];

const DECIMAL_RE = /^-?(\d+(\.\d+)?|\.\d+)$/;

// Per-row quick inventory adjustment. Posts immediately: negative qty
// consumes FIFO (system-calculated cost), positive creates a new layer at
// WAC. Auto-posts the GL adjustment JE.
export function QuickAdjustButton({
  variantId,
  warehouseId,
  variantSku,
  warehouseCode,
}: {
  variantId: string;
  warehouseId: string;
  variantSku: string;
  warehouseCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [category, setCategory] = useState('SHORTAGE');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setQty('');
    setCategory('SHORTAGE');
    setReason('');
    setNotes('');
    setErrors({});
  }, [open]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    const trimmedQty = qty.trim();
    if (!DECIMAL_RE.test(trimmedQty) || Number(trimmedQty) === 0) {
      next.qty = 'Enter a non-zero number (use - to remove stock)';
    }
    if (!reason.trim()) next.reason = 'Reason is required';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/inventory-adjustments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variantId,
            warehouseId,
            qtyChange: trimmedQty,
            category,
            reason: reason.trim(),
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Adjustment failed (${res.status})`);
          return;
        }
        const adj = (await res.json()) as { number: string };
        toast.success(`Posted adjustment ${adj.number}.`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <SlidersHorizontal />
        Adjust
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Adjust inventory</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{variantSku}</span> at{' '}
              <span className="font-mono">{warehouseCode}</span>. Posts
              immediately — negative removes stock (FIFO cost), positive adds
              at weighted-average cost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <Field>
              <FieldLabel htmlFor="adj-qty">
                Quantity change (+ add / − remove)
              </FieldLabel>
              <Input
                id="adj-qty"
                inputMode="decimal"
                placeholder="e.g. -3 or 5"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                aria-invalid={!!errors.qty}
              />
              <FieldError
                errors={[errors.qty ? { message: errors.qty } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="adj-category">Category</FieldLabel>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v ?? 'SHORTAGE')}
              >
                <SelectTrigger id="adj-category" className="w-full">
                  <SelectValue>
                    {(v) => CATEGORIES.find((c) => c.value === v)?.label ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="adj-reason">Reason</FieldLabel>
              <Input
                id="adj-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. damaged in transit"
                aria-invalid={!!errors.reason}
              />
              <FieldError
                errors={[errors.reason ? { message: errors.reason } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="adj-notes">Notes</FieldLabel>
              <Textarea
                id="adj-notes"
                rows={2}
                placeholder="optional"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submit} disabled={pending}>
              {pending ? 'Posting…' : 'Post adjustment'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
