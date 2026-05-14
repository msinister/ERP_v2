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

export function ApplicationRowActions({
  applicationId,
  vendorCreditNumber,
  reversed,
}: {
  applicationId: string;
  vendorCreditNumber: string;
  reversed: boolean;
}) {
  // No actions on reversed rows — historical, append-only.
  if (reversed) return null;
  return (
    <ReverseAction
      applicationId={applicationId}
      vendorCreditNumber={vendorCreditNumber}
    />
  );
}

function ReverseAction({
  applicationId,
  vendorCreditNumber,
}: {
  applicationId: string;
  vendorCreditNumber: string;
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
        const res = await fetch(
          `/api/vendor-credit-applications/${applicationId}/reverse`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Reverse failed (${res.status})`);
          return;
        }
        toast.success(`Reversed application of ${vendorCreditNumber}`);
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
              aria-label={`Actions for application of ${vendorCreditNumber}`}
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
            Reverse application
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
            <AlertDialogTitle>Reverse this application?</AlertDialogTitle>
            <AlertDialogDescription>
              Frees the credit&apos;s available balance and restores the
              bill&apos;s remaining balance. No GL post — the application
              never posted a JE (the credit&apos;s confirm already moved
              the cash from AP to Vendor Credits Available).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="reverse-app-reason">Reason</FieldLabel>
            <Textarea
              id="reverse-app-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. applied to wrong bill"
              aria-invalid={!!error}
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              Keep application
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onReverse}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? 'Reversing…' : 'Reverse'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
