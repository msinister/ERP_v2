'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import {
  highlightSegments,
  variantMatches,
} from '@/lib/variant-search';
import {
  QuickCreateProductDialog,
  type CreatedProduct,
} from '@/components/shared/quick-create-product-dialog';

// Re-export so call sites can pull the create payload type alongside the
// picker from a single module.
export type { CreatedProduct };

// Shared variant picker. Wraps the base-ui Combobox with the multi-
// field client-side filter described in the spec (matches against
// SKU, product name, variant name, shortDescription, and per-vendor
// vendorSku from catalogHints). Highlights matching text in results.
// Keyboard nav (arrows / Enter / Escape) is provided by base-ui.
//
// Two extensibility seams for the form-specific work:
//   - `catalogHints` (per-vendor map keyed by variantId) wires the
//     vendorSku into the search corpus AND surfaces a "Vendor SKU"
//     hint in the rendered row. Auto-filling unitCost on select is
//     CALLER's job (different forms have different field names) —
//     read `hint.latestCost` from the same map in your onValueChange.
//   - `renderItemMeta` is rendered on the right of each row — used
//     by the SO form to show per-warehouse QOH/Available, and by the
//     PO form to show the "In catalog" badge for the selected vendor.
//   - Inline product create (default on): typing a SKU/name with no
//     exact match surfaces a "+ Create [name]" option that opens a
//     minimal dialog, creates the product + default variant, selects it
//     on this line, and (via onCreated) lets multi-line forms append it
//     to their shared list so sibling lines see it too. Disable with
//     allowCreate={false}.

export type VariantPickerOption = {
  id: string;
  sku: string;
  productName: string;
  variantName?: string | null;
  shortDescription?: string | null;
};

export type VariantPickerCatalogHint = {
  vendorSku: string | null;
  latestCost: string | null;
};

export type VariantPickerProps = {
  value: string | null;
  onValueChange: (id: string | null) => void;
  variants: VariantPickerOption[];
  /** Per-variant vendor metadata (keyed by variant id). Adds vendorSku
   * to the search corpus and surfaces it in the rendered row. */
  catalogHints?: Map<string, VariantPickerCatalogHint>;
  /** Optional pre-sort function (e.g. PO form puts in-catalog
   * variants first). Applied to the FULL list, then filtered. */
  sortVariants?: (a: VariantPickerOption, b: VariantPickerOption) => number;
  placeholder?: string;
  ariaInvalid?: boolean;
  id?: string;
  disabled?: boolean;
  /** Right-side cell content for each result row. */
  renderItemMeta?: (variant: VariantPickerOption) => ReactNode;
  /** Override the default "No matching products." copy. */
  emptyMessage?: string;
  /** Show the inline "+ Create [name]" option + dialog. Default true. */
  allowCreate?: boolean;
  /** Notified after a successful inline create. Multi-line forms use this
   * to append the new variant to their shared options list so sibling
   * lines see it. The picker already selects it on this line and keeps a
   * local copy, so wiring this is optional. */
  onCreated?: (created: CreatedProduct) => void;
};

export function VariantPicker({
  value,
  onValueChange,
  variants,
  catalogHints,
  sortVariants,
  placeholder = 'Search SKU, product name, or description…',
  ariaInvalid,
  id,
  disabled,
  renderItemMeta,
  emptyMessage = 'No matching products.',
  allowCreate = true,
  onCreated,
}: VariantPickerProps) {
  // Format used both for the input's display string and for matching
  // a selected value back to a label.
  const labelFor = (v: VariantPickerOption): string =>
    `${v.sku} ${v.productName}${v.variantName ? ` — ${v.variantName}` : ''}`;

  // Products created inline via the "+ Create" dialog. Kept locally so the
  // picker keeps working standalone even when the caller doesn't wire
  // onCreated (the freshly-created variant stays selectable on this line).
  const [extraVariants, setExtraVariants] = useState<VariantPickerOption[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createQuery, setCreateQuery] = useState('');

  // Caller-supplied options first; inline-created ones appended unless the
  // caller already merged them into `variants` (dedupe by id).
  const allVariants = useMemo(() => {
    if (extraVariants.length === 0) return variants;
    const ids = new Set(variants.map((v) => v.id));
    return [...variants, ...extraVariants.filter((v) => !ids.has(v.id))];
  }, [variants, extraVariants]);

  // Initial input string: when value is preselected, display its
  // label. Otherwise blank.
  const initialVariant = useMemo(
    () => (value ? allVariants.find((v) => v.id === value) ?? null : null),
    // Run only on first render; subsequent external value changes are
    // handled by the watch-effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [query, setQuery] = useState<string>(
    initialVariant ? labelFor(initialVariant) : '',
  );

  // Keep the displayed string in sync with externally-driven value
  // changes (e.g. parent setValue() after a quick-create dialog).
  // Skip when the change came from the user typing — the user is
  // mid-edit and we shouldn't trample their input.
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    if (!value) {
      setQuery('');
      return;
    }
    const v = allVariants.find((x) => x.id === value);
    if (v) setQuery(labelFor(v));
  }, [value, allVariants]);

  const sorted = useMemo(() => {
    if (!sortVariants) return allVariants;
    return [...allVariants].sort(sortVariants);
  }, [allVariants, sortVariants]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q === '') return sorted;
    return sorted.filter((v) => {
      const hint = catalogHints?.get(v.id);
      return variantMatches(
        {
          sku: v.sku,
          productName: v.productName,
          variantName: v.variantName ?? null,
          shortDescription: v.shortDescription ?? null,
          vendorSku: hint?.vendorSku ?? null,
        },
        q,
      );
    });
  }, [sorted, query, catalogHints]);

  // Offer create when the operator has typed something with no exact SKU
  // or product-name match — and never on a disabled (read-only) picker.
  const trimmedQuery = query.trim();
  const hasExactMatch = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (q === '') return false;
    return allVariants.some(
      (v) => v.sku.toLowerCase() === q || v.productName.toLowerCase() === q,
    );
  }, [allVariants, trimmedQuery]);
  const showCreate =
    allowCreate && !disabled && trimmedQuery !== '' && !hasExactMatch;

  // New product created inline → keep a local copy (so this picker can
  // render + select it), notify the caller (so sibling lines see it), and
  // select it on this line.
  function handleCreated(created: CreatedProduct) {
    const option: VariantPickerOption = {
      id: created.variantId,
      sku: created.sku,
      productName: created.productName,
      variantName: created.variantName,
      shortDescription: created.shortDescription,
    };
    setExtraVariants((prev) =>
      prev.some((v) => v.id === option.id) ? prev : [...prev, option],
    );
    onCreated?.(created);
    onValueChange(option.id);
    setQuery(labelFor(option));
  }

  return (
    <>
      <Combobox<string>
        value={value || null}
        onValueChange={(v) => {
          onValueChange(v ?? null);
          const picked = v ? allVariants.find((x) => x.id === v) : null;
          setQuery(picked ? labelFor(picked) : '');
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(idValue) => {
          const v = allVariants.find((x) => x.id === idValue);
          return v ? labelFor(v) : '';
        }}
        disabled={disabled}
      >
        <ComboboxInputGroup aria-invalid={ariaInvalid}>
          <ComboboxInput id={id} placeholder={placeholder} />
          <ComboboxTrigger />
        </ComboboxInputGroup>
        <ComboboxContent>
          <ComboboxList>
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {emptyMessage}
              </div>
            ) : (
              filtered.map((v) => {
                const hint = catalogHints?.get(v.id);
                return (
                  <ComboboxItem key={v.id} value={v.id}>
                    <div className="flex w-full items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-medium">
                          <Highlight text={v.sku} query={query} />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <Highlight text={v.productName} query={query} />
                          {v.variantName ? (
                            <>
                              {' — '}
                              <Highlight text={v.variantName} query={query} />
                            </>
                          ) : null}
                        </div>
                        {v.shortDescription &&
                        isMatchingExclusiveOf(
                          query,
                          v.shortDescription,
                          v.sku,
                          v.productName,
                          v.variantName,
                          hint?.vendorSku,
                        ) ? (
                          <div className="line-clamp-1 text-[11px] text-muted-foreground/80">
                            <Highlight
                              text={v.shortDescription}
                              query={query}
                            />
                          </div>
                        ) : null}
                        {hint?.vendorSku ? (
                          <div className="text-[11px] text-muted-foreground">
                            Vendor SKU:{' '}
                            <span className="font-mono">
                              <Highlight text={hint.vendorSku} query={query} />
                            </span>
                            {hint.latestCost ? (
                              <span className="ml-2">
                                · Last cost ${hint.latestCost}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {renderItemMeta ? (
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          {renderItemMeta(v)}
                        </div>
                      ) : null}
                    </div>
                  </ComboboxItem>
                );
              })
            )}
          </ComboboxList>
          {showCreate ? (
            <>
              {filtered.length > 0 ? <ComboboxSeparator /> : null}
              <button
                type="button"
                onClick={() => {
                  setCreateQuery(trimmedQuery);
                  setCreateOpen(true);
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
              >
                <Plus className="size-3.5" />
                Create &ldquo;{trimmedQuery}&rdquo;
              </button>
            </>
          ) : null}
        </ComboboxContent>
      </Combobox>
      {allowCreate ? (
        <QuickCreateProductDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialQuery={createQuery}
          onCreated={handleCreated}
        />
      ) : null}
    </>
  );
}

// Avoid showing the shortDescription line when the match came from
// any of the always-rendered fields — keeps the row compact for the
// common case (typing a SKU prefix) and only expands when the
// description is the field that actually matched.
function isMatchingExclusiveOf(
  query: string,
  description: string,
  ...alreadyShown: ReadonlyArray<string | null | undefined>
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  if (!description.toLowerCase().includes(q)) return false;
  for (const s of alreadyShown) {
    if (s && s.toLowerCase().includes(q)) return false;
  }
  return true;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className={cn(
              'rounded-sm bg-yellow-200/70 px-0.5 text-foreground',
              'dark:bg-yellow-500/30 dark:text-foreground',
            )}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// Convenience badge for the "In catalog" hint — exposed so call
// sites can reuse the same chip in renderItemMeta or elsewhere.
export function InCatalogBadge() {
  return (
    <Badge variant="secondary" className="text-[10px]">
      In catalog
    </Badge>
  );
}
