'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export type ContactRow = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
};

const ROLE_SUGGESTIONS = ['Owner', 'Buyer', 'AP', 'AR', 'Manager', 'Shipping'];

type Props = {
  customerId: string;
  contact?: ContactRow; // undefined = add mode
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Errors = Partial<Record<string, string>>;

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ path?: Array<string | number>; message?: string }>;
    };
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

export function ContactFormDialog({
  customerId,
  contact,
  open,
  onOpenChange,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = contact !== undefined;

  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [errors, setErrors] = useState<Errors>({});

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

  function validate(): Errors {
    const e: Errors = {};
    if (!name.trim()) e.name = 'Required';
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      e.email = 'Invalid email address';
    }
    return e;
  }

  function submit() {
    const e = validate();
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return;
    }
    setErrors({});

    const payload: Record<string, unknown> = {
      name: name.trim(),
      role: role.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      mobile: mobile.trim() || undefined,
      isPrimary,
    };

    startTransition(async () => {
      try {
        const url = isEdit
          ? `/api/customers/${customerId}/contacts/${contact!.id}`
          : `/api/customers/${customerId}/contacts`;
        const res = await fetch(url, {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Contact updated' : 'Contact added');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit contact' : 'Add contact'}
          </AlertDialogTitle>
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

          {/* Role with native datalist suggestions (free-text + common values) */}
          <Field>
            <FieldLabel htmlFor="contact-role">Role</FieldLabel>
            <Input
              id="contact-role"
              list="contact-role-suggestions"
              placeholder="e.g. Owner, Buyer, AP…"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
            <datalist id="contact-role-suggestions">
              {ROLE_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>

          <Field>
            <FieldLabel htmlFor="contact-email">Email</FieldLabel>
            <Input
              id="contact-email"
              type="email"
              placeholder="optional"
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
                type="tel"
                placeholder="optional"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="contact-mobile">Mobile</FieldLabel>
              <Input
                id="contact-mobile"
                type="tel"
                placeholder="optional"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id="contact-primary"
              checked={isPrimary}
              onCheckedChange={(v) => setIsPrimary(v === true)}
            />
            <Label htmlFor="contact-primary" className="text-sm font-normal cursor-pointer">
              Mark as primary contact
            </Label>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Add contact'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
