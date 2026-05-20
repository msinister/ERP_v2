'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export type CompanyInfoOnDisk = {
  name: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
};

type FieldKey = keyof CompanyInfoOnDisk;

const FIELDS: Array<{ key: FieldKey; label: string; placeholder?: string }> = [
  { key: 'name', label: 'Company name' },
  { key: 'logoUrl', label: 'Logo URL', placeholder: '/logo.png or https://…' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'State / region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
];

function emptyState(initial: CompanyInfoOnDisk | null): Record<FieldKey, string> {
  return {
    name: initial?.name ?? '',
    addressLine1: initial?.addressLine1 ?? '',
    addressLine2: initial?.addressLine2 ?? '',
    city: initial?.city ?? '',
    region: initial?.region ?? '',
    postalCode: initial?.postalCode ?? '',
    country: initial?.country ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    logoUrl: initial?.logoUrl ?? '',
  };
}

export function CompanyInfoForm({
  initial,
}: {
  initial: CompanyInfoOnDisk | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<FieldKey, string>>(
    emptyState(initial),
  );

  function set(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    // Send empty strings as-is; the server schema trims and normalizes
    // them to null. This appears on every printable document header.
    const body: Record<FieldKey, string | null> = {
      name: values.name,
      addressLine1: values.addressLine1,
      addressLine2: values.addressLine2,
      city: values.city,
      region: values.region,
      postalCode: values.postalCode,
      country: values.country,
      phone: values.phone,
      email: values.email,
      logoUrl: values.logoUrl,
    };
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/settings/company_info', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(errBody.error ?? `Save failed (${res.status})`);
          return;
        }
        toast.success('Saved company info');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Shown in the header of every printable document (invoices, POs,
        statements, etc.). Logo URL is optional; leave blank for text-only
        branding.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key}>
            <FieldLabel htmlFor={`company-${f.key}`}>{f.label}</FieldLabel>
            <Input
              id={`company-${f.key}`}
              value={values[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
