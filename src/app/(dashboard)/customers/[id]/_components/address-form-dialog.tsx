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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

type AddressKind = 'BILLING' | 'SHIPPING';

export type AddressRow = {
  id: string;
  kind: AddressKind;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  attention: string | null;
  phone: string | null;
  isDefault: boolean;
};

type Props = {
  customerId: string;
  address?: AddressRow; // undefined = add mode
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasBillingAddress?: boolean;
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

export function AddressFormDialog({
  customerId,
  address,
  open,
  onOpenChange,
  hasBillingAddress = false,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = address !== undefined;

  // Form state
  const [kind, setKind] = useState<AddressKind>('SHIPPING');
  const [label, setLabel] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('US');
  const [attention, setAttention] = useState('');
  const [phone, setPhone] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [errors, setErrors] = useState<Errors>({});

  // Seed from address when dialog opens
  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (address) {
      setKind(address.kind);
      setLabel(address.label ?? '');
      setLine1(address.line1);
      setLine2(address.line2 ?? '');
      setCity(address.city);
      setRegion(address.region);
      setPostalCode(address.postalCode);
      setCountry(address.country);
      setAttention(address.attention ?? '');
      setPhone(address.phone ?? '');
      setIsDefault(address.isDefault);
    } else {
      setKind('SHIPPING');
      setLabel('');
      setLine1('');
      setLine2('');
      setCity('');
      setRegion('');
      setPostalCode('');
      setCountry('US');
      setAttention('');
      setPhone('');
      setIsDefault(false);
    }
  }, [open, address]);

  function validate(): Errors {
    const e: Errors = {};
    if (!line1.trim()) e.line1 = 'Required';
    if (!city.trim()) e.city = 'Required';
    if (!region.trim()) e.region = 'Required';
    if (!postalCode.trim()) e.postalCode = 'Required';
    if (country && country.length !== 2) e.country = 'Must be a 2-letter ISO country code';
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
      label: label.trim() || undefined,
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim(),
      region: region.trim(),
      postalCode: postalCode.trim(),
      country: country.trim() || 'US',
      attention: attention.trim() || undefined,
      phone: phone.trim() || undefined,
    };

    if (!isEdit) {
      payload.kind = kind;
      if (kind === 'SHIPPING') payload.isDefault = isDefault;
    } else {
      // Kind is immutable; only pass isDefault for shipping
      if (address!.kind === 'SHIPPING') payload.isDefault = isDefault;
    }

    startTransition(async () => {
      try {
        const url = isEdit
          ? `/api/customers/${customerId}/addresses/${address!.id}`
          : `/api/customers/${customerId}/addresses`;
        const res = await fetch(url, {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Address updated' : 'Address added');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const title = isEdit ? 'Edit address' : 'Add address';
  const showKindSelector = !isEdit;
  const effectiveKind = isEdit ? address!.kind : kind;
  const billingWarning =
    !isEdit && kind === 'BILLING' && hasBillingAddress
      ? 'A billing address already exists — this will become the new default.'
      : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {billingWarning ? (
            <AlertDialogDescription className="text-amber-600">
              {billingWarning}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>

        <div className="space-y-3">
          {showKindSelector ? (
            <Field>
              <FieldLabel htmlFor="addr-kind">Type</FieldLabel>
              <Select value={kind} onValueChange={(v) => setKind((v ?? 'SHIPPING') as AddressKind)}>
                <SelectTrigger id="addr-kind" className="w-full">
                  <SelectValue>
                    {(v: string) => (v === 'BILLING' ? 'Billing' : 'Shipping')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BILLING">Billing</SelectItem>
                  <SelectItem value="SHIPPING">Shipping</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {effectiveKind === 'BILLING' ? 'Billing address' : 'Shipping address'}
            </div>
          )}

          <Field>
            <FieldLabel htmlFor="addr-label">Label / name</FieldLabel>
            <Input
              id="addr-label"
              placeholder="e.g. Main Warehouse"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="addr-attention">Attention</FieldLabel>
            <Input
              id="addr-attention"
              placeholder="optional"
              value={attention}
              onChange={(e) => setAttention(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="addr-line1">Address line 1</FieldLabel>
            <Input
              id="addr-line1"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              aria-invalid={!!errors.line1}
            />
            <FieldError errors={[errors.line1 ? { message: errors.line1 } : undefined]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="addr-line2">Address line 2</FieldLabel>
            <Input
              id="addr-line2"
              placeholder="optional"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="addr-city">City</FieldLabel>
              <Input
                id="addr-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                aria-invalid={!!errors.city}
              />
              <FieldError errors={[errors.city ? { message: errors.city } : undefined]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="addr-region">State / province</FieldLabel>
              <Input
                id="addr-region"
                placeholder="e.g. CA"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                aria-invalid={!!errors.region}
              />
              <FieldError errors={[errors.region ? { message: errors.region } : undefined]} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="addr-zip">ZIP / postal code</FieldLabel>
              <Input
                id="addr-zip"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                aria-invalid={!!errors.postalCode}
              />
              <FieldError errors={[errors.postalCode ? { message: errors.postalCode } : undefined]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="addr-country">Country (ISO-2)</FieldLabel>
              <Input
                id="addr-country"
                placeholder="US"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                aria-invalid={!!errors.country}
              />
              <FieldError errors={[errors.country ? { message: errors.country } : undefined]} />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="addr-phone">Phone</FieldLabel>
            <Input
              id="addr-phone"
              type="tel"
              placeholder="optional"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>

          {effectiveKind === 'SHIPPING' ? (
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="addr-default"
                checked={isDefault}
                onCheckedChange={(v) => setIsDefault(v === true)}
              />
              <Label htmlFor="addr-default" className="text-sm font-normal cursor-pointer">
                Set as default ship-to address
              </Label>
            </div>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Add address'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
