'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type RuleType =
  | 'INCLUDE_ALL'
  | 'INCLUDE_VENDOR'
  | 'EXCLUDE_VENDOR'
  | 'INCLUDE_CATEGORY'
  | 'EXCLUDE_CATEGORY'
  | 'INCLUDE_TAG'
  | 'EXCLUDE_TAG';

export type RuleRow = {
  id: string;
  ruleType: RuleType;
  value: string;
  sortOrder: number;
};

const RULE_LABELS: Record<RuleType, string> = {
  INCLUDE_ALL: 'Include all products',
  INCLUDE_VENDOR: 'Include products where vendor is',
  EXCLUDE_VENDOR: 'Exclude products where vendor is',
  INCLUDE_CATEGORY: 'Include products where category is',
  EXCLUDE_CATEGORY: 'Exclude products where category is',
  INCLUDE_TAG: 'Include products where tag is',
  EXCLUDE_TAG: 'Exclude products where tag is',
};

// Per-store routing rule editor. Wholesale-replace semantics — Save sends
// the current row list to PUT /api/admin/shopify/stores/:id/rules and the
// service atomically deletes + reinserts. Live match-count preview is
// re-fetched after every successful save so operators can immediately see
// the impact of their rule changes.
//
// Value typeahead is via native <datalist> per ruleType — gives autocomplete
// from existing vendors/categories/tags while still letting operators type
// any string (a vendor that exists in Shopify but not yet in the ERP, etc.).

type DraftRow = { key: string; ruleType: RuleType; value: string };

function isAllRule(t: RuleType): boolean {
  return t === 'INCLUDE_ALL';
}

function vendorList(t: RuleType): boolean {
  return t === 'INCLUDE_VENDOR' || t === 'EXCLUDE_VENDOR';
}
function categoryList(t: RuleType): boolean {
  return t === 'INCLUDE_CATEGORY' || t === 'EXCLUDE_CATEGORY';
}
function tagList(t: RuleType): boolean {
  return t === 'INCLUDE_TAG' || t === 'EXCLUDE_TAG';
}

let nextLocalId = 1;
function genKey(): string {
  nextLocalId += 1;
  return `new-${nextLocalId}`;
}

export function RuleBuilder({
  storeId,
  initialRules,
  initialMatchCount,
  vendorOptions,
  categoryOptions,
  tagOptions,
}: {
  storeId: string;
  initialRules: RuleRow[];
  initialMatchCount: number;
  vendorOptions: string[];
  categoryOptions: string[];
  tagOptions: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<DraftRow[]>(
    initialRules.map((r) => ({
      key: r.id,
      ruleType: r.ruleType,
      value: r.value,
    })),
  );
  const [matchCount, setMatchCount] = useState(initialMatchCount);
  const [savedSignature, setSavedSignature] = useState(() =>
    signatureOf(
      initialRules.map((r) => ({ ruleType: r.ruleType, value: r.value })),
    ),
  );

  const vendorListId = useId();
  const categoryListId = useId();
  const tagListId = useId();

  const dirty =
    savedSignature !==
    signatureOf(rows.map((r) => ({ ruleType: r.ruleType, value: r.value })));

  function addRow(ruleType: RuleType) {
    setRows((prev) => [
      ...prev,
      { key: genKey(), ruleType, value: '' },
    ]);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function updateRow(key: string, patch: Partial<DraftRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        // INCLUDE_ALL has no value; force it blank so accidental leftover
        // text doesn't get stored and ignored at evaluation time.
        if (isAllRule(next.ruleType)) next.value = '';
        return next;
      }),
    );
  }

  function onSave() {
    // Validate: every non-INCLUDE_ALL row needs a non-empty value.
    for (const r of rows) {
      if (!isAllRule(r.ruleType) && r.value.trim() === '') {
        toast.error(`Each "${RULE_LABELS[r.ruleType]}" row needs a value.`);
        return;
      }
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/shopify/stores/${storeId}/rules`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rules: rows.map((r, i) => ({
                ruleType: r.ruleType,
                value: r.value.trim(),
                sortOrder: i,
              })),
            }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ message?: string }>;
          };
          toast.error(
            body.issues?.[0]?.message ??
              body.error ??
              `Save failed (${res.status})`,
          );
          return;
        }
        const body = (await res.json()) as {
          rules: RuleRow[];
          matchCount: number;
        };
        setRows(
          body.rules.map((r) => ({
            key: r.id,
            ruleType: r.ruleType,
            value: r.value,
          })),
        );
        setMatchCount(body.matchCount);
        setSavedSignature(
          signatureOf(
            body.rules.map((r) => ({ ruleType: r.ruleType, value: r.value })),
          ),
        );
        toast.success(
          `Rules saved — matches ${body.matchCount} product${body.matchCount === 1 ? '' : 's'}.`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Rules decide which products sync to / push inventory to this store.
        Include rules are additive (union). Exclude rules override includes.
        With no rules, nothing syncs — an explicit opt-in is required.
      </p>

      {/* Datalists for native typeahead. Same list reused across rows of
          the same ruleType. */}
      <datalist id={vendorListId}>
        {vendorOptions.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id={categoryListId}>
        {categoryOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id={tagListId}>
        {tagOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No rules yet — add one below. Until at least one rule exists,
          nothing syncs to this store.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const listId = vendorList(r.ruleType)
              ? vendorListId
              : categoryList(r.ruleType)
                ? categoryListId
                : tagList(r.ruleType)
                  ? tagListId
                  : undefined;
            return (
              <li
                key={r.key}
                className="flex items-center gap-2 rounded-md border p-2"
              >
                <Select
                  value={r.ruleType}
                  onValueChange={(v) =>
                    updateRow(r.key, { ruleType: v as RuleType })
                  }
                >
                  <SelectTrigger className="w-72 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RULE_LABELS) as RuleType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {RULE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {isAllRule(r.ruleType) ? (
                  <div className="flex-1 text-xs italic text-muted-foreground">
                    (no value)
                  </div>
                ) : (
                  <Input
                    list={listId}
                    placeholder={
                      vendorList(r.ruleType)
                        ? 'Vendor name'
                        : categoryList(r.ruleType)
                          ? 'Category'
                          : 'Tag name'
                    }
                    value={r.value}
                    onChange={(e) =>
                      updateRow(r.key, { value: e.target.value })
                    }
                    className="flex-1"
                  />
                )}

                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  aria-label="Remove rule"
                  onClick={() => removeRow(r.key)}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addRow('INCLUDE_VENDOR')}
          >
            <Plus />
            Add vendor rule
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addRow('INCLUDE_CATEGORY')}
          >
            <Plus />
            Add category rule
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addRow('INCLUDE_TAG')}
          >
            <Plus />
            Add tag rule
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addRow('INCLUDE_ALL')}
          >
            <Plus />
            Include all
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            Matches{' '}
            <span className="font-semibold text-foreground tabular-nums">
              {matchCount}
            </span>{' '}
            {matchCount === 1 ? 'product' : 'products'}
            {dirty ? ' (before save)' : ''}
          </div>
          <Button type="button" onClick={onSave} disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function signatureOf(rows: Array<{ ruleType: string; value: string }>): string {
  return rows.map((r) => `${r.ruleType}:${r.value.trim()}`).join('|');
}
