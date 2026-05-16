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
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// =============================================================================
// Generic click-to-edit cell for PO line inline editing. Twin of the SO
// component in /sales-orders/[id]/_components/inline-editable-cell.tsx
// — kept local rather than lifted to a shared file to keep the two
// surfaces free to evolve independently. If a third use-case shows up,
// lift then.
//
// Lifecycle:
//   - view → click → editing (autofocus the input).
//   - editing → blur OR Enter → validate → PATCH → on ok return to
//     view with the new display; on error toast + revert.
//   - editing → Escape → revert without saving.
//   - During the PATCH, a Loader2 spinner overlays the input;
//     further input is disabled until the request settles.
// =============================================================================

export type InlineEditableCellProps = {
  displayValue: ReactNode;
  rawValue: string;
  validate: (raw: string) => { value: string; error: null } | { value: null; error: string };
  save: (parsed: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  emptyPlaceholder?: ReactNode;
  inputClassName?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  type?: 'text' | 'number';
  className?: string;
  ariaLabel?: string;
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
