'use client';

import { useEffect, useState, useTransition } from 'react';
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

// Audited cleartext reveal for a single vendor payment method. Every
// open() writes a SENSITIVE_READ AuditLog row (server-side, before
// decrypt). The response is no-store, the dialog NEVER persists the
// payload anywhere — it lives only in component state while open and
// is cleared on close.
//
// WARNING: do NOT log, screenshot, or copy the payload outside this
// dialog. Anything that does — including a route refresh that re-uses
// the open state — will re-trigger the SENSITIVE_READ audit row, by
// design.

type Decrypted =
  | { kind: 'ACH'; payload: AchPayload }
  | { kind: 'WIRE'; payload: WirePayload }
  | { kind: 'CHECK'; payload: CheckPayload }
  | { kind: 'CREDIT_CARD'; payload: CardPayload };

type AchPayload = {
  routingNumber: string;
  accountNumber: string;
  accountName: string;
  bankName?: string;
};
type WirePayload = AchPayload & {
  swiftCode?: string;
  intermediaryBank?: string;
};
type CheckPayload = {
  payeeName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country?: string;
};
type CardPayload = {
  last4: string;
  brand: string;
  expirationMonth?: number;
  expirationYear?: number;
};

export function PaymentMethodRevealDialog({
  vendorId,
  paymentMethodId,
  label,
  open,
  onOpenChange,
}: {
  vendorId: string;
  paymentMethodId: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [decrypted, setDecrypted] = useState<Decrypted | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open. The /cleartext endpoint returns no-store + writes
  // the audit row before decrypt, so this fetch IS the audited event.
  useEffect(() => {
    if (!open) {
      // Defensive scrub: clear local copy on close. React would unmount
      // anyway, but explicit clearing keeps the lifetime obvious.
      setDecrypted(null);
      setError(null);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/vendors/${vendorId}/payment-methods/${paymentMethodId}/cleartext`,
          {
            method: 'GET',
            cache: 'no-store',
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error ?? `Reveal failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as Decrypted;
        setDecrypted(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    });
  }, [open, vendorId, paymentMethodId]);

  function onCopy(value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed'),
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Reveal payment details</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{label}</span> — this
            access is recorded in the audit log as a SENSITIVE_READ event.
            Close the dialog when finished.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          {pending && !decrypted && !error ? (
            <p className="text-muted-foreground">Decrypting…</p>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {decrypted ? (
            <DecryptedPanel decrypted={decrypted} onCopy={onCopy} />
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {/* Primary action button intentionally omitted — there's no
              affirmative action; the read already happened. */}
          <span aria-hidden="true">
            <AlertDialogAction className="hidden" />
          </span>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DecryptedPanel({
  decrypted,
  onCopy,
}: {
  decrypted: Decrypted;
  onCopy: (value: string) => void;
}) {
  switch (decrypted.kind) {
    case 'ACH':
      return (
        <dl className="space-y-2">
          <Row label="Routing #" value={decrypted.payload.routingNumber} onCopy={onCopy} mono />
          <Row label="Account #" value={decrypted.payload.accountNumber} onCopy={onCopy} mono />
          <Row label="Account name" value={decrypted.payload.accountName} onCopy={onCopy} />
          {decrypted.payload.bankName ? (
            <Row label="Bank" value={decrypted.payload.bankName} onCopy={onCopy} />
          ) : null}
        </dl>
      );
    case 'WIRE':
      return (
        <dl className="space-y-2">
          <Row label="Routing #" value={decrypted.payload.routingNumber} onCopy={onCopy} mono />
          <Row label="Account #" value={decrypted.payload.accountNumber} onCopy={onCopy} mono />
          <Row label="Account name" value={decrypted.payload.accountName} onCopy={onCopy} />
          {decrypted.payload.bankName ? (
            <Row label="Bank" value={decrypted.payload.bankName} onCopy={onCopy} />
          ) : null}
          {decrypted.payload.swiftCode ? (
            <Row label="SWIFT / BIC" value={decrypted.payload.swiftCode} onCopy={onCopy} mono />
          ) : null}
          {decrypted.payload.intermediaryBank ? (
            <Row
              label="Intermediary bank"
              value={decrypted.payload.intermediaryBank}
              onCopy={onCopy}
            />
          ) : null}
        </dl>
      );
    case 'CHECK':
      return (
        <dl className="space-y-2">
          <Row label="Payee" value={decrypted.payload.payeeName} onCopy={onCopy} />
          <Row
            label="Address"
            value={[
              decrypted.payload.line1,
              decrypted.payload.line2,
              `${decrypted.payload.city}, ${decrypted.payload.region} ${decrypted.payload.postalCode}`,
              decrypted.payload.country,
            ]
              .filter(Boolean)
              .join('\n')}
            onCopy={onCopy}
            multiline
          />
        </dl>
      );
    case 'CREDIT_CARD':
      return (
        <dl className="space-y-2">
          <Row label="Brand" value={decrypted.payload.brand} onCopy={onCopy} />
          <Row label="Last 4" value={decrypted.payload.last4} onCopy={onCopy} mono />
          {decrypted.payload.expirationMonth && decrypted.payload.expirationYear ? (
            <Row
              label="Exp"
              value={`${String(decrypted.payload.expirationMonth).padStart(2, '0')}/${decrypted.payload.expirationYear}`}
              onCopy={onCopy}
              mono
            />
          ) : null}
        </dl>
      );
  }
}

function Row({
  label,
  value,
  onCopy,
  mono,
  multiline,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          className={
            multiline
              ? 'whitespace-pre-line text-foreground'
              : mono
                ? 'font-mono text-foreground'
                : 'text-foreground'
          }
        >
          {value}
        </dd>
      </div>
      <button
        type="button"
        onClick={() => onCopy(value)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Copy
      </button>
    </div>
  );
}
