'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isPositiveDecimalInput, normalizeDecimalForSubmit } from '@/lib/decimal-input';
import {
  LAST_PAYMENT_ACCOUNT_KEY,
  type AccountOption,
  type CategoryOption,
} from './types';

type DraftRow = {
  key: number;
  date: string; // YYYY-MM-DD or '' (server defaults to today)
  vendorName: string;
  amount: string;
  categoryId: string;
};

// Normalize a pasted date cell to YYYY-MM-DD. Handles the two common
// shapes (ISO + US M/D/Y); anything else returns '' so the server falls
// back to today rather than guessing wrong.
function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (us) {
    const [, mo, d, y] = us;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return '';
}

// Strip currency symbols / thousands separators / parens-negatives from a
// pasted amount; keep the bare number for validation + submit.
function normalizeAmount(raw: string): string {
  return raw.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1').trim();
}

export function ExpenseBulkPaste({
  categories,
  paymentAccounts,
}: {
  categories: CategoryOption[];
  paymentAccounts: AccountOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [paymentAccountId, setPaymentAccountId] = useState<string>(
    paymentAccounts[0]?.id ?? '',
  );
  const keyRef = useRef(0);

  useEffect(() => {
    const saved = window.localStorage.getItem(LAST_PAYMENT_ACCOUNT_KEY);
    if (saved && paymentAccounts.some((a) => a.id === saved)) {
      setPaymentAccountId(saved);
    }
  }, [paymentAccounts]);

  // Default category = most-used (first), used when a pasted category cell
  // doesn't match an account by code or name.
  const defaultCategoryId = categories[0]?.id ?? '';
  const categoryByText = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) {
      map.set(c.code.toLowerCase(), c.id);
      map.set(c.name.toLowerCase(), c.id);
    }
    return map;
  }, [categories]);

  const categoryLabel = useMemo(() => {
    const map = new Map(categories.map((c) => [c.id, `${c.code} ${c.name}`]));
    return (id: string) => map.get(id) ?? id;
  }, [categories]);
  const accountLabel = useMemo(() => {
    const map = new Map(
      paymentAccounts.map((a) => [a.id, `${a.code} ${a.name}`]),
    );
    return (id: string) => map.get(id) ?? id;
  }, [paymentAccounts]);

  function parse() {
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (lines.length === 0) {
      toast.error('Nothing to parse — paste some rows first.');
      return;
    }
    // Drop a header row if the first cell isn't a date and the amount cell
    // isn't numeric (heuristic — bank exports often include headers).
    const parsed: DraftRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split('\t');
      const [dateCell = '', descCell = '', amountCell = '', categoryCell = ''] =
        cells;
      const amount = normalizeAmount(amountCell);
      const date = normalizeDate(dateCell);
      // Skip an obvious header line.
      if (i === 0 && date === '' && !isPositiveDecimalInput(amount)) {
        continue;
      }
      const catKey = categoryCell.trim().toLowerCase();
      const categoryId = categoryByText.get(catKey) ?? defaultCategoryId;
      parsed.push({
        key: keyRef.current++,
        date,
        vendorName: descCell.trim(),
        amount,
        categoryId,
      });
    }
    if (parsed.length === 0) {
      toast.error('No data rows found.');
      return;
    }
    setRows(parsed);
  }

  function patch(key: number, p: Partial<DraftRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }
  function removeRow(key: number) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function logAll() {
    if (!paymentAccountId) {
      toast.error('Pick a payment account for the batch.');
      return;
    }
    // Validate every row up front so a bad cell doesn't roll back the
    // (atomic) server batch after a long round-trip.
    const cleaned = rows.filter(
      (r) => r.vendorName.trim() !== '' || r.amount.trim() !== '',
    );
    if (cleaned.length === 0) {
      toast.error('No rows to log.');
      return;
    }
    for (let i = 0; i < cleaned.length; i++) {
      const r = cleaned[i];
      if (r.vendorName.trim() === '') {
        toast.error(`Row ${i + 1}: description / vendor is required.`);
        return;
      }
      if (!isPositiveDecimalInput(r.amount)) {
        toast.error(`Row ${i + 1}: amount must be a positive number.`);
        return;
      }
      if (!r.categoryId) {
        toast.error(`Row ${i + 1}: pick a category.`);
        return;
      }
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/expenses/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentAccountId,
            rows: cleaned.map((r) => ({
              vendorName: r.vendorName.trim(),
              amount: normalizeDecimalForSubmit(r.amount),
              expenseAccountId: r.categoryId,
              date: r.date || undefined,
            })),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Batch failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { results: unknown[] };
        window.localStorage.setItem(LAST_PAYMENT_ACCOUNT_KEY, paymentAccountId);
        toast.success(`Logged ${data.results.length} expenses`);
        setRaw('');
        setRows([]);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Paste from spreadsheet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Paste tab-separated rows from Excel or a bank statement. Columns:{' '}
          <span className="font-medium">Date, Description, Amount, Category</span>{' '}
          (category optional). Review and fix the preview, then log them all.
        </p>
        <Textarea
          rows={5}
          placeholder={
            '2026-05-21\tStaples\t42.18\tOffice Expense\n2026-05-20\tUber\t23.40'
          }
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={parse} disabled={pending}>
            Parse rows
          </Button>
          {rows.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {rows.length} row{rows.length === 1 ? '' : 's'} ready
            </span>
          ) : null}
        </div>

        {rows.length > 0 ? (
          <>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-semibold">Date</th>
                    <th className="px-2 py-2 font-semibold">Description / vendor</th>
                    <th className="px-2 py-2 text-right font-semibold">Amount</th>
                    <th className="px-2 py-2 font-semibold">Category</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-border">
                      <td className="px-2 py-1.5">
                        <Input
                          type="date"
                          value={r.date}
                          onChange={(e) => patch(r.key, { date: e.target.value })}
                          className="h-8 w-36"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          value={r.vendorName}
                          onChange={(e) =>
                            patch(r.key, { vendorName: e.target.value })
                          }
                          className="h-8 min-w-[160px]"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          inputMode="decimal"
                          value={r.amount}
                          onChange={(e) =>
                            patch(r.key, { amount: e.target.value })
                          }
                          className="h-8 w-24 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Select
                          value={r.categoryId}
                          onValueChange={(v) =>
                            patch(r.key, { categoryId: v ?? '' })
                          }
                        >
                          <SelectTrigger className="h-8 w-full min-w-[180px]">
                            <SelectValue placeholder="Pick…">
                              {(v) => (v ? categoryLabel(v) : 'Pick…')}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {categories.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                <span className="font-mono text-xs text-muted-foreground">
                                  {c.code}
                                </span>{' '}
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove row"
                          onClick={() => removeRow(r.key)}
                        >
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field className="w-64">
                <FieldLabel htmlFor="bulk-account">
                  Pay all from
                </FieldLabel>
                <Select
                  value={paymentAccountId}
                  onValueChange={(v) => setPaymentAccountId(v ?? '')}
                >
                  <SelectTrigger id="bulk-account" className="w-full">
                    <SelectValue placeholder="Pick…">
                      {(v) => (v ? accountLabel(v) : 'Pick…')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {paymentAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="font-mono text-xs text-muted-foreground">
                          {a.code}
                        </span>{' '}
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button onClick={logAll} disabled={pending}>
                {pending ? `Logging ${rows.length}…` : `Log all ${rows.length}`}
              </Button>
            </div>

            {pending ? (
              <div className="space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-full animate-pulse bg-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Logging {rows.length} expenses… this runs as one atomic
                  batch, so leave the tab open.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
