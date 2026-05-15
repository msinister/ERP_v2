'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

// Inline qtyShipped editor for the SO detail page's Qty shipped column.
// Auto-saves on blur via PATCH /api/sales-orders/[id]/lines/[lineId]
// when the field is editable (SO in CONFIRMED / DISPATCHED). Skips the
// fetch when the value is unchanged from the persisted server value.
//
// Pre-fill chain: prior saved qtyShipped (when > 0) → qtyOrdered. Lets
// the warehouse leave the default for full shipments and only type when
// recording a short.
export function QtyShippedInput({
  salesOrderId,
  lineId,
  qtyOrdered,
  qtyShipped,
  editable,
}: {
  salesOrderId: string;
  lineId: string;
  qtyOrdered: string;
  qtyShipped: string;
  editable: boolean;
}) {
  const router = useRouter();
  const initialValue =
    Number(qtyShipped) > 0 ? qtyShipped : qtyOrdered;
  // savedRef tracks the last value we know is persisted server-side, so
  // we only PATCH on blur when the value actually changed since the
  // previous successful save (or, on first edit, since the initial
  // server-rendered value).
  const savedRef = useRef(initialValue);
  const [value, setValue] = useState(initialValue);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [pending, startTransition] = useTransition();

  if (!editable) {
    return (
      <span className="tabular-nums text-muted-foreground">
        {Number(qtyShipped) > 0 ? qtyShipped : '—'}
      </span>
    );
  }

  function onBlur() {
    const trimmed = value.trim();
    if (trimmed === savedRef.current) {
      // No change. Don't burn a request; also clear any prior error /
      // saved indicator from the previous attempt.
      setState({ kind: 'idle' });
      return;
    }
    // Loose client-side guard — server is the source of truth.
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      setState({ kind: 'error', message: 'Must be a positive number' });
      return;
    }
    const n = Number(trimmed);
    if (!(n > 0)) {
      setState({ kind: 'error', message: 'Must be > 0' });
      return;
    }
    if (n > Number(qtyOrdered)) {
      setState({ kind: 'error', message: `Max ${qtyOrdered}` });
      return;
    }
    setState({ kind: 'saving' });
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/sales-orders/${salesOrderId}/lines/${lineId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qtyShipped: trimmed }),
          },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setState({
            kind: 'error',
            message: errBody.error ?? `Save failed (${res.status})`,
          });
          return;
        }
        savedRef.current = trimmed;
        setState({ kind: 'saved' });
        // Refresh server-rendered totals (line total, totals card,
        // reservation hint) so the rest of the page reflects the new
        // value without a full reload.
        router.refresh();
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        });
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Input
        inputMode="decimal"
        aria-label="Qty shipped"
        className="h-7 w-20 text-right tabular-nums"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onBlur}
        disabled={pending}
        aria-invalid={state.kind === 'error'}
      />
      <SaveIndicator state={state} />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  switch (state.kind) {
    case 'saving':
      return (
        <Loader2
          className="size-3.5 animate-spin text-muted-foreground"
          aria-label="Saving"
        />
      );
    case 'saved':
      return (
        <Check
          className="size-3.5 text-emerald-600 dark:text-emerald-500"
          aria-label="Saved"
        />
      );
    case 'error':
      return (
        // Native title attribute on the wrapper = lightweight hover
        // tooltip without pulling in a tooltip primitive for a single
        // error state. aria-label on the icon covers screen readers.
        <span title={state.message} className="inline-flex">
          <AlertCircle
            className="size-3.5 text-destructive"
            aria-label={state.message}
          />
        </span>
      );
    case 'idle':
    default:
      return <span className="inline-block size-3.5" aria-hidden />;
  }
}
