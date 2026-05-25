'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

export type ContactFormDialogContact = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
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

// Shared add + edit dialog for vendor contacts. When `contact` is null
// we POST /api/vendors/[id]/contacts; otherwise PATCH the per-contact
// route. The service enforces single-isPrimary-per-vendor, so toggling
// isPrimary on edit / create is safe — concurrent toggles serialize
// behind a SELECT ... FOR UPDATE.
export function ContactFormDialog({
  vendorId,
  contact,
  open,
  onOpenChange,
}: {
  vendorId: string;
  contact: ContactFormDialogContact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed state every time the dialog opens so reopening for a
  // different contact doesn't leak stale values from the previous edit.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (contact) {
      setName(contact.name);
      setRole(contact.role ?? '');
      setEmail(contact.email ?? '');
      setPhone(contact.phone ?? '');
      setMobile(contact.mobile ?? '');
      setIsPrimary(contact.isPrimary);
    } else {
      setName('');
      setRole('');
      setEmail('');
      setPhone('');
      setMobile('');
      setIsPrimary(false);
    }
  }, [open, contact]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (name.trim() === '') next.name = 'Required';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      next.email = 'Invalid email';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const payload = {
      name: name.trim(),
      role: role.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      mobile: mobile.trim() || undefined,
      isPrimary,
    };
    startTransition(async () => {
      try {
        const isEdit = contact != null;
        const url = isEdit
          ? `/api/vendors/${vendorId}/contacts/${contact.id}`
          : `/api/vendors/${vendorId}/contacts`;
        const method = isEdit ? 'PATCH' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? `Saved ${payload.name}` : `Added ${payload.name}`);
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = contact != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit contact' : 'Add contact'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Role is free-text — common values are AR, AP, Buyer, Sales rep,
            Owner. Marking primary unsets any other primary on this vendor.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="contact-name">Name</FieldLabel>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
            />
            <FieldError errors={[errors.name ? { message: errors.name } : undefined]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="contact-role">Role (optional)</FieldLabel>
            <Input
              id="contact-role"
              placeholder="e.g. AR"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="contact-email">Email</FieldLabel>
            <Input
              id="contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!errors.email}
            />
            <FieldError errors={[errors.email ? { message: errors.email } : undefined]} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="contact-phone">Phone</FieldLabel>
              <Input
                id="contact-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="contact-mobile">Mobile</FieldLabel>
              <Input
                id="contact-mobile"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
              />
            </Field>
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="contact-primary"
              checked={isPrimary}
              onCheckedChange={(v) => setIsPrimary(v === true)}
            />
            <FieldLabel htmlFor="contact-primary">Primary contact</FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add contact'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
