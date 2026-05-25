'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';
import {
  isPositiveDecimalInput,
  normalizeDecimalForSubmit,
} from '@/lib/decimal-input';

export type CategoryOption = {
  id: string;
  code: string;
  label: string;
  affectsInventory: boolean;
};

// One row per RMA line. The dialog seeds qty/unitPrice/description from
// the RMA + invoice line snapshot; operator can override qty (must be
// ≤ rmaLine.qty per the server) but the unitPrice ties back to the
// original invoice line so the AR reversal lands cleanly.
export type CreditLineInput = {
  invoiceLineId: string;
  qty: string;
  unitPrice: string;
  description: string;
  variantSku: string;
  productName: string;
  variantName: string | null;
};

type ApiErrorBody = {
  error?: string;
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
};

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function IssueCreditDialog({
  rmaId,
  rmaNumber,
  lines,
  categories,
  open,
  onOpenChange,
}: {
  rmaId: string;
  rmaNumber: string;
  lines: CreditLineInput[];
  categories: CategoryOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Default category preference: RETURN if present, else first active.
  const defaultCategoryId = (() => {
    const ret = categories.find((c) => c.code === 'RETURN');
    return ret?.id ?? categories[0]?.id ?? '';
  })();

  const [categoryId, setCategoryId] = useState<string>(defaultCategoryId);
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<CreditLineInput[]>(lines);
  const [errors, setErrors] = useState<{
    categoryId?: string;
    lines?: Array<string | undefined>;
  }>({});

  // Reset on open. Reuses the seeded rows so re-opens don't carry over
  // edits from a prior attempt.
  useEffect(() => {
    if (!open) return;
    setRows(lines);
    setCategoryId(defaultCategoryId);
    setReason('');
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totals = rows.reduce(
    (acc, r) => {
      const q = Number(r.qty);
      const u = Number(r.unitPrice);
      if (!Number.isFinite(q) || !Number.isFinite(u)) return acc;
      return { gross: acc.gross + q * u, hasNaN: acc.hasNaN };
    },
    { gross: 0, hasNaN: false },
  );

  function updateRow(idx: number, patch: Partial<CreditLineInput>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function submit() {
    const next: typeof errors = { lines: [] };
    if (!categoryId) next.categoryId = 'Pick a category';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!isPositiveDecimalInput(r.qty)) {
        next.lines![i] = 'Qty must be > 0';
      }
    }
    const hasErrors =
      next.categoryId || (next.lines && next.lines.some((e) => !!e));
    if (hasErrors) {
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const payload = {
          categoryId,
          reason: reason.trim() || undefined,
          lines: rows.map((r) => ({
            invoiceLineId: r.invoiceLineId,
            qty: normalizeDecimalForSubmit(r.qty),
            unitPrice: normalizeDecimalForSubmit(r.unitPrice),
            description: r.description.trim() || r.productName,
          })),
        };
        const res = await fetch(`/api/rmas/${rmaId}/credit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const result = (await res.json()) as {
          rma: { id: string; number: string };
          creditMemo: { id: string; number: string };
        };
        toast.success(
          `${rmaNumber} credited via ${result.creditMemo.number}`,
        );
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const selectedCategory = categories.find((c) => c.id === categoryId) ?? null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Issue credit</AlertDialogTitle>
          <AlertDialogDescription>
            Drafts and confirms a credit memo for {rmaNumber} in one
            atomic step. The credit auto-applies to the original invoice;
            inventory routing is decided by the chosen category.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="cm-category">Category</FieldLabel>
            <Select
              value={categoryId}
              onValueChange={(v) => setCategoryId(v ?? '')}
            >
              <SelectTrigger
                id="cm-category"
                className="w-full"
                aria-invalid={!!errors.categoryId}
              >
                <SelectValue placeholder="Pick a category">
                  {(v) => {
                    if (!v) return null;
                    const c = categories.find((x) => x.id === v);
                    return c?.label ?? v;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                      {c.code}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              errors={[
                errors.categoryId ? { message: errors.categoryId } : undefined,
              ]}
            />
            {selectedCategory ? (
              <p className="text-[10px] text-muted-foreground">
                {selectedCategory.affectsInventory
                  ? 'Goods restore to FIFO inventory at original cost when the credit memo confirms.'
                  : 'No inventory effect — pure AR (or loss-reclassification if the category is configured for it).'}
              </p>
            ) : null}
          </Field>

          <div className="space-y-2">
            <FieldLabel>Lines</FieldLabel>
            <div className="space-y-2">
              {rows.map((r, idx) => {
                const lineErr = errors.lines?.[idx];
                const lineTotal =
                  Number.isFinite(Number(r.qty)) &&
                  Number.isFinite(Number(r.unitPrice))
                    ? Number(r.qty) * Number(r.unitPrice)
                    : null;
                return (
                  <div
                    key={r.invoiceLineId}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="mb-2">
                      <div className="font-mono text-xs text-muted-foreground">
                        {r.variantSku}
                      </div>
                      <div className="text-sm font-medium">
                        {r.productName}
                        {r.variantName ? ` · ${r.variantName}` : ''}
                      </div>
                    </div>
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-4 md:col-span-2">
                        <Field>
                          <FieldLabel htmlFor={`cl-${idx}-qty`}>
                            Qty
                          </FieldLabel>
                          <Input
                            id={`cl-${idx}-qty`}
                            inputMode="decimal"
                            value={r.qty}
                            onChange={(e) =>
                              updateRow(idx, { qty: e.target.value })
                            }
                            aria-invalid={!!lineErr}
                          />
                          <FieldError
                            errors={[lineErr ? { message: lineErr } : undefined]}
                          />
                        </Field>
                      </div>
                      <div className="col-span-4 md:col-span-3">
                        <Field>
                          <FieldLabel htmlFor={`cl-${idx}-up`}>
                            Unit price
                          </FieldLabel>
                          <Input
                            id={`cl-${idx}-up`}
                            inputMode="decimal"
                            value={r.unitPrice}
                            onChange={(e) =>
                              updateRow(idx, { unitPrice: e.target.value })
                            }
                          />
                        </Field>
                      </div>
                      <div className="col-span-12 md:col-span-5">
                        <Field>
                          <FieldLabel htmlFor={`cl-${idx}-desc`}>
                            Description
                          </FieldLabel>
                          <Input
                            id={`cl-${idx}-desc`}
                            value={r.description}
                            onChange={(e) =>
                              updateRow(idx, { description: e.target.value })
                            }
                          />
                        </Field>
                      </div>
                      <div className="col-span-4 md:col-span-2 flex items-end justify-end pb-1">
                        <div className="text-right text-xs">
                          <div className="text-muted-foreground">Ext.</div>
                          <div className="tabular-nums font-medium">
                            {lineTotal != null
                              ? formatCurrency(lineTotal.toFixed(2))
                              : '—'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end border-t border-border pt-2 text-sm">
              <div className="text-right">
                <div className="text-xs text-muted-foreground">
                  Gross credit
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCurrency(totals.gross.toFixed(2))}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Restocking fee (RMA override or admin default) is applied
              automatically and subtracted from net credit on the
              resulting credit memo.
            </p>
          </div>

          <Field>
            <FieldLabel htmlFor="cm-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="cm-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`From RMA ${rmaNumber}`}
            />
          </Field>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Issuing…' : 'Issue credit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
