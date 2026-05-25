'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Undo2 } from 'lucide-react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { formatCurrency } from '@/lib/format';

type ApiErrorBody = { error?: string };

export function UnapplyButton({
  paymentId,
  applicationId,
  invoiceNumber,
  amount,
}: {
  paymentId: string;
  applicationId: string;
  invoiceNumber: string;
  /** Decimal-as-string. */
  amount: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/payments/${paymentId}/unapply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
          toast.error(body.error ?? `Unapply failed (${res.status})`);
          return;
        }
        toast.success(
          `Unapplied ${formatCurrency(amount)} from ${invoiceNumber}.`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <Undo2 />
            Unapply
          </Button>
        }
      />
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Unapply {formatCurrency(amount)} from {invoiceNumber}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The amount will return to unapplied credit on the customer&apos;s
            account. The payment itself stays recorded — only this allocation
            is undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Unapplying…' : 'Unapply'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
