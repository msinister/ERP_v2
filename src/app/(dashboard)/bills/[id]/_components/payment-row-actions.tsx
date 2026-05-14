'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

export function PaymentRowActions({
  paymentId,
  paymentNumber,
  status,
}: {
  paymentId: string;
  paymentNumber: string;
  status: string;
}) {
  // Only RECORDED payments can be reversed. REVERSED rows just show
  // the dropdown disabled (or we skip rendering it).
  if (status !== 'RECORDED') return null;
  return <ReverseAction paymentId={paymentId} paymentNumber={paymentNumber} />;
}

function ReverseAction({
  paymentId,
  paymentNumber,
}: {
  paymentId: string;
  paymentNumber: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onReverse() {
    setError(null);
    if (reason.trim().length === 0) {
      setError('Reason is required');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/bill-payments/${paymentId}/reverse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Reverse failed (${res.status})`);
          return;
        }
        toast.success(`Reversed ${paymentNumber}`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${paymentNumber}`}
            />
          }
        >
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <Undo2 className="size-4" />
            Reverse
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setReason('');
            setError(null);
          }
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              Posts a mirror JE (DR cash / CR AP) and restores the bill
              balance. If an overpayment vendor credit was auto-created
              from this payment, it gets cancelled in the same tx unless
              it&apos;s already been applied — in that case the reverse
              is rejected and you&apos;ll need to reverse the credit
              application first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="reverse-reason">Reason</FieldLabel>
            <Textarea
              id="reverse-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. ACH returned NSF, check bounced, etc."
              aria-invalid={!!error}
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep payment</AlertDialogCancel>
            <AlertDialogAction
              onClick={onReverse}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? 'Reversing…' : 'Reverse payment'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
