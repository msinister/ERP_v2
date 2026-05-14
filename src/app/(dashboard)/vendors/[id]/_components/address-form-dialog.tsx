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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type AddressFormDialogAddress = {
  id: string;
  kind: 'REMIT_TO' | 'SHIPPING' | 'BILLING';
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

// Add + edit dialog for vendor addresses. Kind is fixed on edit
// (changing kind would require unsetting the default + re-adding under
// the new kind — too risky to do silently). On create, kind defaults
// to REMIT_TO since that's the canonical AP destination.
export function AddressFormDialog({
  vendorId,
  address,
  open,
  onOpenChange,
}: {
  vendorId: string;
  address: AddressFormDialogAddress | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<'REMIT_TO' | 'SHIPPING' | 'BILLING'>(
    'REMIT_TO',
  );
  const [label, setLabel] = useState('');
  const [attention, setAttention] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [phone, setPhone] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (address) {
      setKind(address.kind);
      setLabel(address.label ?? '');
      setAttention(address.attention ?? '');
      setLine1(address.line1);
      setLine2(address.line2 ?? '');
      setCity(address.city);
      setRegion(address.region);
      setPostalCode(address.postalCode);
      setCountry(address.country);
      setPhone(address.phone ?? '');
      setIsDefault(address.isDefault);
    } else {
      setKind('REMIT_TO');
      setLabel('');
      setAttention('');
      setLine1('');
      setLine2('');
      setCity('');
      setRegion('');
      setPostalCode('');
      setCountry('');
      setPhone('');
      setIsDefault(false);
    }
  }, [open, address]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (line1.trim() === '') next.line1 = 'Required';
    if (city.trim() === '') next.city = 'Required';
    if (region.trim() === '') next.region = 'Required';
    if (postalCode.trim() === '') next.postalCode = 'Required';
    if (country && country.trim().length !== 2)
      next.country = 'ISO-3166 alpha-2';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const isEdit = address != null;
    // Create uses the discriminated-union vendorAddressInputSchema (kind
    // is part of the body). Edit uses updateVendorAddressInputSchema
    // (no kind field — kind is immutable). Build the payload to match.
    const createPayload = {
      kind,
      label: label.trim() || undefined,
      attention: attention.trim() || undefined,
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim(),
      region: region.trim(),
      postalCode: postalCode.trim(),
      country: country.trim().toUpperCase() || undefined,
      phone: phone.trim() || undefined,
      isDefault,
    };
    const editPayload = (() => {
      const { kind: _k, ...rest } = createPayload;
      void _k;
      return rest;
    })();
    startTransition(async () => {
      try {
        const url = isEdit
          ? `/api/vendors/${vendorId}/addresses/${address.id}`
          : `/api/vendors/${vendorId}/addresses`;
        const method = isEdit ? 'PATCH' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isEdit ? editPayload : createPayload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Saved address' : 'Added address');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = address != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit address' : 'Add address'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            REMIT_TO is the canonical AP destination (where checks get cut).
            Shipping and Billing kinds are rare on vendors. Default flag is
            per kind.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="addr-kind">Kind</FieldLabel>
            <Select
              value={kind}
              onValueChange={(v) =>
                setKind(v as 'REMIT_TO' | 'SHIPPING' | 'BILLING')
              }
              disabled={isEdit}
            >
              <SelectTrigger id="addr-kind" className="w-full">
                <SelectValue>
                  {(v) =>
                    v === 'REMIT_TO'
                      ? 'Remit-to'
                      : v === 'SHIPPING'
                        ? 'Shipping'
                        : v === 'BILLING'
                          ? 'Billing'
                          : v
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="REMIT_TO">Remit-to</SelectItem>
                <SelectItem value="SHIPPING">Shipping</SelectItem>
                <SelectItem value="BILLING">Billing</SelectItem>
              </SelectContent>
            </Select>
            {isEdit ? (
              <p className="text-xs text-muted-foreground">
                Kind is fixed on edit. Delete and re-add to change it.
              </p>
            ) : null}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="addr-label">Label (optional)</FieldLabel>
              <Input
                id="addr-label"
                placeholder="e.g. HQ"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="addr-attention">
                Attention (optional)
              </FieldLabel>
              <Input
                id="addr-attention"
                value={attention}
                onChange={(e) => setAttention(e.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="addr-line1">Line 1</FieldLabel>
            <Input
              id="addr-line1"
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              aria-invalid={!!errors.line1}
            />
            <FieldError errors={[errors.line1 ? { message: errors.line1 } : undefined]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="addr-line2">Line 2 (optional)</FieldLabel>
            <Input
              id="addr-line2"
              value={line2}
              onChange={(e) => setLine2(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
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
              <FieldLabel htmlFor="addr-region">State / region</FieldLabel>
              <Input
                id="addr-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                aria-invalid={!!errors.region}
              />
              <FieldError errors={[errors.region ? { message: errors.region } : undefined]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="addr-postal">Postal code</FieldLabel>
              <Input
                id="addr-postal"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                aria-invalid={!!errors.postalCode}
              />
              <FieldError
                errors={[errors.postalCode ? { message: errors.postalCode } : undefined]}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="addr-country">
                Country (ISO-3166 alpha-2, blank = US)
              </FieldLabel>
              <Input
                id="addr-country"
                placeholder="US"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                aria-invalid={!!errors.country}
              />
              <FieldError
                errors={[errors.country ? { message: errors.country } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="addr-phone">Phone (optional)</FieldLabel>
              <Input
                id="addr-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="addr-default"
              checked={isDefault}
              onCheckedChange={(v) => setIsDefault(v === true)}
            />
            <FieldLabel htmlFor="addr-default">
              Default for this kind
            </FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add address'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
