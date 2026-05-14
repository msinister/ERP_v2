'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

export type TermFormDialogTerm = {
  id: string;
  code: string;
  label: string;
  netDays: number | null;
  active: boolean;
};

type ApiErrorBody = {
  error?: string;
  issues?: Array<{ path?: Array<string | number>; message?: string }>;
};

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function TermFormDialog({
  term,
  open,
  onOpenChange,
}: {
  term: TermFormDialogTerm | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  // netDays carrier: '' means COD/Prepay (null on server); any other
  // value parses to a non-negative integer.
  const [netDays, setNetDays] = useState('');
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (term) {
      setCode(term.code);
      setLabel(term.label);
      setNetDays(term.netDays != null ? String(term.netDays) : '');
      setActive(term.active);
    } else {
      setCode('');
      setLabel('');
      setNetDays('');
      setActive(true);
    }
  }, [open, term]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!term && code.trim() === '') next.code = 'Required';
    if (label.trim() === '') next.label = 'Required';
    if (netDays.trim() !== '') {
      const n = Number(netDays);
      if (!Number.isInteger(n) || n < 0 || n > 365)
        next.netDays = '0–365, or blank for COD/Prepay';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const isEdit = term != null;
    const parsedNetDays = netDays.trim() === '' ? null : Number(netDays);
    const url = isEdit
      ? `/api/payment-terms/${term.id}`
      : `/api/payment-terms`;
    const method = isEdit ? 'PATCH' : 'POST';
    const body = isEdit
      ? { label: label.trim(), netDays: parsedNetDays, active }
      : {
          code: code.trim(),
          label: label.trim(),
          netDays: parsedNetDays,
          active,
        };
    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Saved term' : 'Added term');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = term != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit payment term' : 'Add payment term'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Code is fixed on edit — services reference it as a stable
            identifier. Blank net days = COD/Prepay (due immediately on
            the invoice / bill date).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="term-code">Code</FieldLabel>
              <Input
                id="term-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={isEdit}
                aria-invalid={!!errors.code}
                className="font-mono"
                placeholder="e.g. NET30"
              />
              <FieldError
                errors={[errors.code ? { message: errors.code } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="term-netdays">
                Net days (blank = COD)
              </FieldLabel>
              <Input
                id="term-netdays"
                inputMode="numeric"
                value={netDays}
                onChange={(e) => setNetDays(e.target.value)}
                aria-invalid={!!errors.netDays}
                placeholder="e.g. 30"
              />
              <FieldError
                errors={[errors.netDays ? { message: errors.netDays } : undefined]}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="term-label">Label</FieldLabel>
            <Input
              id="term-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-invalid={!!errors.label}
              placeholder="e.g. Net 30"
            />
            <FieldError
              errors={[errors.label ? { message: errors.label } : undefined]}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="term-active"
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            <FieldLabel htmlFor="term-active">Active</FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add term'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
