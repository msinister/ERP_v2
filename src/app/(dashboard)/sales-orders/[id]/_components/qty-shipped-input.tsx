'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
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

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type OverShippingPolicy = 'ALLOW' | 'CONFIRM' | 'BLOCK';

// Inline qtyShipped editor for the SO detail page's Qty shipped column.
// Auto-saves on blur via PATCH /api/sales-orders/[id]/lines/[lineId]
// when the field is editable (SO in CONFIRMED / DISPATCHED). Skips the
// fetch when the value is unchanged from the persisted server value.
//
// Over-shipping (qtyShipped > qtyOrdered) is gated by the tenant-wide
// overShippingPolicy setting — passed from the SO detail page server-
// side render:
//   BLOCK   → reject locally with an inline error.
//   CONFIRM → pop an AlertDialog "Ship more than ordered?" before
//             firing the PATCH. Operator can confirm or cancel.
//   ALLOW   → save immediately, no prompt.
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
  overShippingPolicy,
}: {
  salesOrderId: string;
  lineId: string;
  qtyOrdered: string;
  qtyShipped: string;
  editable: boolean;
  overShippingPolicy: OverShippingPolicy;
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
  // Over-ship pending value — set when blur triggers a CONFIRM dialog.
  // The dialog uses this to render the "ordered X, shipping Y" copy
  // and the confirm handler reads it back for the PATCH body.
  const [confirmPending, setConfirmPending] = useState<string | null>(null);

  if (!editable) {
    return (
      <span className="tabular-nums text-muted-foreground">
        {Number(qtyShipped) > 0 ? qtyShipped : '—'}
      </span>
    );
  }

  // Push the value to the server. Pulled out so both the direct-save
  // path and the post-confirm path share one implementation.
  function persist(trimmed: string) {
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
          // Revert the input back to the last-saved value so the
          // operator's screen reflects the rejection.
          setValue(savedRef.current);
          return;
        }
        savedRef.current = trimmed;
        setState({ kind: 'saved' });
        router.refresh();
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error',
        });
        setValue(savedRef.current);
      }
    });
  }

  function onBlur() {
    const trimmed = value.trim();
    if (trimmed === savedRef.current) {
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
    const ordered = Number(qtyOrdered);
    if (n > ordered) {
      // Over-shipping path. Branch on tenant policy.
      if (overShippingPolicy === 'BLOCK') {
        setState({ kind: 'error', message: `Max ${qtyOrdered}` });
        return;
      }
      if (overShippingPolicy === 'CONFIRM') {
        // Open the confirm dialog; persist happens on confirm.
        setConfirmPending(trimmed);
        return;
      }
      // ALLOW — fall through to direct save.
    }
    persist(trimmed);
  }

  function onConfirmOverShip() {
    if (confirmPending == null) return;
    const t = confirmPending;
    setConfirmPending(null);
    persist(t);
  }
  function onCancelOverShip() {
    setConfirmPending(null);
    // Revert the input value back to the saved one so the warehouse
    // can re-enter a different number without it looking like the
    // over-ship value stuck.
    setValue(savedRef.current);
    setState({ kind: 'idle' });
  }

  return (
    // inline-flex (not flex) so the wrapper collapses to content
    // width and inherits the parent's text-align. In the desktop
    // table's text-right cell the wrapper sits flush right; in the
    // mobile card's default-left Stat cell it sits flush left,
    // aligned with the other stat values (Ordered, Unit price, etc.).
    <div className="inline-flex items-center gap-1.5">
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
      <AlertDialog
        open={confirmPending != null}
        onOpenChange={(o) => {
          if (!o) onCancelOverShip();
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Ship more than ordered?</AlertDialogTitle>
            <AlertDialogDescription>
              Ordered: {qtyOrdered}. Shipping: {confirmPending ?? ''}. This
              will be recorded as an over-shipment on the SO line.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelOverShip}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmOverShip}>
              Ship {confirmPending ?? ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
