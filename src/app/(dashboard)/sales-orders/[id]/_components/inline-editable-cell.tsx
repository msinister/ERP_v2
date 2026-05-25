'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// =============================================================================
// Generic click-to-edit cell. Pulls together the SO detail page's
// inline-editable fields (qty, price, discount, customer note, internal
// note) under one component.
//
// Lifecycle:
//   - view → click → editing (autofocus the input).
//   - editing → blur OR Enter → validate → POST → on ok return to
//     view with the new display; on error toast + revert.
//   - editing → Escape → revert without saving.
//   - During the PATCH, a Loader2 spinner overlays the input;
//     further input is disabled until the request settles.
//
// The caller hands in:
//   - `displayValue`: what to show in view mode (ReactNode for
//     formatting flexibility — currency, percent, badge, etc.).
//   - `rawValue`: the string form of the field (what the operator
//     types into / sees pre-populated in the input).
//   - `validate`: parses the raw string; returns either an error
//     message or a parsed string ready to PATCH.
//   - `save`: the actual PATCH call. Returns ok or an error string.
//
// On a successful save, router.refresh() is fired so server-rendered
// surfaces (line total, totals card, order-level rollups) update in
// place. The cell itself returns to view mode with the new raw value
// so the operator sees the change without waiting for the refresh.
// =============================================================================

export type InlineEditableCellProps = {
  /** What to render when not editing. */
  displayValue: ReactNode;
  /** Current raw string (what the input pre-fills with). */
  rawValue: string;
  /** Parse + validate; null means "valid, save this string". */
  validate: (raw: string) => { value: string; error: null } | { value: null; error: string };
  /** PATCH callback. Resolves with `ok` to confirm save, or with an error message. */
  save: (parsed: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Optional placeholder shown when rawValue is empty in view mode. */
  emptyPlaceholder?: ReactNode;
  /** Input width — defaults to a moderate w-24 (~6rem). */
  inputClassName?: string;
  /** Input type / mode. Defaults to text; pass 'decimal' for numerics. */
  inputMode?: 'text' | 'decimal' | 'numeric';
  /** Forwarded to the input as `type`. */
  type?: 'text' | 'number';
  /** Wrapping cell className (text-align etc. from the parent). */
  className?: string;
  /** Optional aria-label for the input. */
  ariaLabel?: string;
  /** Read-only mode — renders displayValue without click handlers. */
  readOnly?: boolean;
};

export function InlineEditableCell({
  displayValue,
  rawValue,
  validate,
  save,
  emptyPlaceholder,
  inputClassName,
  inputMode = 'text',
  type = 'text',
  className,
  ariaLabel,
  readOnly = false,
}: InlineEditableCellProps) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'editing' | 'saving'>('view');
  const [raw, setRaw] = useState(rawValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep raw in sync when the parent re-renders with a new server-side
  // value (e.g., after router.refresh from another row's save). Skip
  // while the operator is mid-edit so we don't trample their typing.
  useEffect(() => {
    if (mode === 'view') setRaw(rawValue);
  }, [rawValue, mode]);

  const activate = useCallback(() => {
    if (readOnly || mode !== 'view') return;
    setError(null);
    setRaw(rawValue);
    setMode('editing');
  }, [readOnly, mode, rawValue]);

  const cancel = useCallback(() => {
    setRaw(rawValue);
    setError(null);
    setMode('view');
  }, [rawValue]);

  const commit = useCallback(async () => {
    if (mode !== 'editing') return;
    if (raw === rawValue) {
      // No change — revert silently. The operator clicked into the
      // cell and clicked away without typing.
      setMode('view');
      return;
    }
    const parsed = validate(raw);
    if (parsed.error != null) {
      toast.error(parsed.error);
      cancel();
      return;
    }
    setMode('saving');
    setError(null);
    try {
      const result = await save(parsed.value);
      if (!result.ok) {
        toast.error(result.error);
        cancel();
        return;
      }
      // Server confirmed. Stay in view mode with the new raw value;
      // refresh server-rendered surfaces for line / order totals.
      setRaw(parsed.value);
      setMode('view');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
      cancel();
    }
  }, [mode, raw, rawValue, validate, save, router, cancel]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  // Autofocus on entering edit mode.
  useEffect(() => {
    if (mode === 'editing') {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [mode]);

  if (readOnly || mode === 'view') {
    const isEmpty = rawValue.trim() === '';
    return (
      <button
        type="button"
        // Render as a button so keyboard users get focus + Enter
        // activation. In view mode the visual is unchanged from a
        // plain span — no border / button chrome.
        disabled={readOnly}
        onClick={activate}
        className={cn(
          'inline-flex w-full max-w-full items-baseline text-left',
          readOnly
            ? 'cursor-default'
            : 'cursor-text rounded-sm px-1 py-0.5 -mx-1 -my-0.5 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        aria-label={ariaLabel}
        tabIndex={readOnly ? -1 : 0}
      >
        {isEmpty && emptyPlaceholder != null ? emptyPlaceholder : displayValue}
      </button>
    );
  }

  return (
    <span className={cn('relative inline-flex items-baseline', className)}>
      <Input
        ref={inputRef}
        type={type}
        inputMode={inputMode}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        disabled={mode === 'saving'}
        aria-invalid={!!error}
        aria-label={ariaLabel}
        className={cn('h-7 px-1.5 py-0.5 text-sm', inputClassName)}
      />
      {mode === 'saving' ? (
        <Loader2
          className="pointer-events-none absolute right-1 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-label="Saving"
        />
      ) : null}
    </span>
  );
}
