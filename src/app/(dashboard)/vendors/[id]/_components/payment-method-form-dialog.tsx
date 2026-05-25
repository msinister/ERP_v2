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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Create-only dialog. Payment-method payload is IMMUTABLE per service
// design — to rotate account/routing numbers, soft-delete the row and
// create a new one. So this dialog never handles edit; the row actions
// component handles label/preferred via the metadata PATCH route
// directly. Kept simple intentionally.

type Kind = 'ACH' | 'WIRE' | 'CHECK' | 'CREDIT_CARD';

const ROUTING_RE = /^\d{9}$/;
const ACCOUNT_RE = /^[A-Za-z0-9-]{4,34}$/;
const SWIFT_RE = /^[A-Z0-9]{8,11}$/;
const LAST4_RE = /^\d{4}$/;

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

export function PaymentMethodFormDialog({
  vendorId,
  open,
  onOpenChange,
}: {
  vendorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>('ACH');
  const [label, setLabel] = useState('');
  const [isPreferred, setIsPreferred] = useState(false);

  // ACH / WIRE
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [bankName, setBankName] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [intermediaryBank, setIntermediaryBank] = useState('');
  // CHECK
  const [payeeName, setPayeeName] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  // CREDIT_CARD
  const [last4, setLast4] = useState('');
  const [brand, setBrand] = useState('');
  const [expirationMonth, setExpirationMonth] = useState('');
  const [expirationYear, setExpirationYear] = useState('');

  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed when the dialog opens so a previously-typed account number
  // doesn't linger in memory after a close.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setKind('ACH');
    setLabel('');
    setIsPreferred(false);
    setRoutingNumber('');
    setAccountNumber('');
    setAccountName('');
    setBankName('');
    setSwiftCode('');
    setIntermediaryBank('');
    setPayeeName('');
    setLine1('');
    setLine2('');
    setCity('');
    setRegion('');
    setPostalCode('');
    setCountry('');
    setLast4('');
    setBrand('');
    setExpirationMonth('');
    setExpirationYear('');
  }, [open]);

  function validateAndBuildPayload(): {
    ok: boolean;
    body?: Record<string, unknown>;
  } {
    const next: Partial<Record<string, string>> = {};

    if (kind === 'ACH' || kind === 'WIRE') {
      if (!ROUTING_RE.test(routingNumber))
        next.routingNumber = 'Must be 9 digits';
      if (!ACCOUNT_RE.test(accountNumber))
        next.accountNumber = '4-34 chars, letters/digits/hyphens';
      if (accountName.trim() === '') next.accountName = 'Required';
      if (kind === 'WIRE' && swiftCode && !SWIFT_RE.test(swiftCode))
        next.swiftCode = '8-11 uppercase alphanumeric';
    } else if (kind === 'CHECK') {
      if (payeeName.trim() === '') next.payeeName = 'Required';
      if (line1.trim() === '') next.line1 = 'Required';
      if (city.trim() === '') next.city = 'Required';
      if (region.trim() === '') next.region = 'Required';
      if (postalCode.trim() === '') next.postalCode = 'Required';
    } else if (kind === 'CREDIT_CARD') {
      if (!LAST4_RE.test(last4))
        next.last4 = 'Exactly 4 digits — never enter the full card number';
      if (brand.trim() === '') next.brand = 'Required';
      if (
        expirationMonth &&
        (Number(expirationMonth) < 1 || Number(expirationMonth) > 12)
      )
        next.expirationMonth = '1-12';
      if (
        expirationYear &&
        (Number(expirationYear) < 2000 || Number(expirationYear) > 2100)
      )
        next.expirationYear = '2000-2100';
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return { ok: false };
    }
    setErrors({});

    const common = {
      kind,
      label: label.trim() || undefined,
      isPreferred,
    };
    if (kind === 'ACH') {
      return {
        ok: true,
        body: {
          ...common,
          payload: {
            routingNumber: routingNumber.trim(),
            accountNumber: accountNumber.trim(),
            accountName: accountName.trim(),
            bankName: bankName.trim() || undefined,
          },
        },
      };
    }
    if (kind === 'WIRE') {
      return {
        ok: true,
        body: {
          ...common,
          payload: {
            routingNumber: routingNumber.trim(),
            accountNumber: accountNumber.trim(),
            accountName: accountName.trim(),
            bankName: bankName.trim() || undefined,
            swiftCode: swiftCode.trim().toUpperCase() || undefined,
            intermediaryBank: intermediaryBank.trim() || undefined,
          },
        },
      };
    }
    if (kind === 'CHECK') {
      return {
        ok: true,
        body: {
          ...common,
          payload: {
            payeeName: payeeName.trim(),
            line1: line1.trim(),
            line2: line2.trim() || undefined,
            city: city.trim(),
            region: region.trim(),
            postalCode: postalCode.trim(),
            country: country.trim().toUpperCase() || undefined,
          },
        },
      };
    }
    // CREDIT_CARD
    return {
      ok: true,
      body: {
        ...common,
        payload: {
          last4: last4.trim(),
          brand: brand.trim(),
          expirationMonth: expirationMonth
            ? Number(expirationMonth)
            : undefined,
          expirationYear: expirationYear ? Number(expirationYear) : undefined,
        },
      },
    };
  }

  function submit() {
    const result = validateAndBuildPayload();
    if (!result.ok || !result.body) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/vendors/${vendorId}/payment-methods`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.body),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success('Added payment method');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Add payment method</AlertDialogTitle>
          <AlertDialogDescription>
            Payload is encrypted at rest. To rotate account numbers, delete
            this row and add a new one — payload is immutable by design.
            Credit-card entries are reference metadata only (last 4 + brand
            + exp) — never enter a full card number.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="pm-kind">Kind</FieldLabel>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger id="pm-kind" className="w-full">
                  <SelectValue>
                    {(v) =>
                      v === 'ACH'
                        ? 'ACH'
                        : v === 'WIRE'
                          ? 'Wire'
                          : v === 'CHECK'
                            ? 'Check'
                            : v === 'CREDIT_CARD'
                              ? 'Credit card'
                              : v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACH">ACH</SelectItem>
                  <SelectItem value="WIRE">Wire</SelectItem>
                  <SelectItem value="CHECK">Check</SelectItem>
                  <SelectItem value="CREDIT_CARD">Credit card</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="pm-label">Label (optional)</FieldLabel>
              <Input
                id="pm-label"
                placeholder="e.g. Main checking"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>

          {(kind === 'ACH' || kind === 'WIRE') && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="pm-routing">Routing # (ABA)</FieldLabel>
                  <Input
                    id="pm-routing"
                    inputMode="numeric"
                    maxLength={9}
                    value={routingNumber}
                    onChange={(e) => setRoutingNumber(e.target.value)}
                    aria-invalid={!!errors.routingNumber}
                    className="font-mono"
                  />
                  <FieldError
                    errors={[
                      errors.routingNumber
                        ? { message: errors.routingNumber }
                        : undefined,
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-account">Account #</FieldLabel>
                  <Input
                    id="pm-account"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    aria-invalid={!!errors.accountNumber}
                    className="font-mono"
                  />
                  <FieldError
                    errors={[
                      errors.accountNumber
                        ? { message: errors.accountNumber }
                        : undefined,
                    ]}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="pm-accountname">Account name</FieldLabel>
                <Input
                  id="pm-accountname"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  aria-invalid={!!errors.accountName}
                />
                <FieldError
                  errors={[
                    errors.accountName
                      ? { message: errors.accountName }
                      : undefined,
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pm-bank">Bank name (optional)</FieldLabel>
                <Input
                  id="pm-bank"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                />
              </Field>
              {kind === 'WIRE' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="pm-swift">
                      SWIFT / BIC (optional)
                    </FieldLabel>
                    <Input
                      id="pm-swift"
                      value={swiftCode}
                      onChange={(e) =>
                        setSwiftCode(e.target.value.toUpperCase())
                      }
                      aria-invalid={!!errors.swiftCode}
                      className="font-mono"
                    />
                    <FieldError
                      errors={[
                        errors.swiftCode
                          ? { message: errors.swiftCode }
                          : undefined,
                      ]}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="pm-intermediary">
                      Intermediary bank (optional)
                    </FieldLabel>
                    <Input
                      id="pm-intermediary"
                      value={intermediaryBank}
                      onChange={(e) => setIntermediaryBank(e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </>
          )}

          {kind === 'CHECK' && (
            <>
              <Field>
                <FieldLabel htmlFor="pm-payee">Payee name</FieldLabel>
                <Input
                  id="pm-payee"
                  value={payeeName}
                  onChange={(e) => setPayeeName(e.target.value)}
                  aria-invalid={!!errors.payeeName}
                />
                <FieldError
                  errors={[
                    errors.payeeName ? { message: errors.payeeName } : undefined,
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pm-line1">Line 1</FieldLabel>
                <Input
                  id="pm-line1"
                  value={line1}
                  onChange={(e) => setLine1(e.target.value)}
                  aria-invalid={!!errors.line1}
                />
                <FieldError
                  errors={[errors.line1 ? { message: errors.line1 } : undefined]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pm-line2">Line 2 (optional)</FieldLabel>
                <Input
                  id="pm-line2"
                  value={line2}
                  onChange={(e) => setLine2(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field>
                  <FieldLabel htmlFor="pm-city">City</FieldLabel>
                  <Input
                    id="pm-city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    aria-invalid={!!errors.city}
                  />
                  <FieldError
                    errors={[errors.city ? { message: errors.city } : undefined]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-region">State / region</FieldLabel>
                  <Input
                    id="pm-region"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    aria-invalid={!!errors.region}
                  />
                  <FieldError
                    errors={[
                      errors.region ? { message: errors.region } : undefined,
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-postal">Postal code</FieldLabel>
                  <Input
                    id="pm-postal"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    aria-invalid={!!errors.postalCode}
                  />
                  <FieldError
                    errors={[
                      errors.postalCode
                        ? { message: errors.postalCode }
                        : undefined,
                    ]}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="pm-country">
                  Country (ISO-3166 alpha-2, blank = US)
                </FieldLabel>
                <Input
                  id="pm-country"
                  placeholder="US"
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                />
              </Field>
            </>
          )}

          {kind === 'CREDIT_CARD' && (
            <>
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <strong className="text-foreground">
                  Reference data only.
                </strong>{' '}
                Enter the last 4 digits + brand + expiration. Full card
                numbers go through Authorize.Net CIM — never store the PAN
                here.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="pm-last4">Last 4</FieldLabel>
                  <Input
                    id="pm-last4"
                    inputMode="numeric"
                    maxLength={4}
                    value={last4}
                    onChange={(e) => setLast4(e.target.value)}
                    aria-invalid={!!errors.last4}
                    className="font-mono"
                  />
                  <FieldError
                    errors={[
                      errors.last4 ? { message: errors.last4 } : undefined,
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-brand">Brand</FieldLabel>
                  <Input
                    id="pm-brand"
                    placeholder="Visa"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    aria-invalid={!!errors.brand}
                  />
                  <FieldError
                    errors={[
                      errors.brand ? { message: errors.brand } : undefined,
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-expmonth">
                    Exp month (1-12, optional)
                  </FieldLabel>
                  <Input
                    id="pm-expmonth"
                    inputMode="numeric"
                    maxLength={2}
                    value={expirationMonth}
                    onChange={(e) => setExpirationMonth(e.target.value)}
                    aria-invalid={!!errors.expirationMonth}
                  />
                  <FieldError
                    errors={[
                      errors.expirationMonth
                        ? { message: errors.expirationMonth }
                        : undefined,
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pm-expyear">
                    Exp year (yyyy, optional)
                  </FieldLabel>
                  <Input
                    id="pm-expyear"
                    inputMode="numeric"
                    maxLength={4}
                    value={expirationYear}
                    onChange={(e) => setExpirationYear(e.target.value)}
                    aria-invalid={!!errors.expirationYear}
                  />
                  <FieldError
                    errors={[
                      errors.expirationYear
                        ? { message: errors.expirationYear }
                        : undefined,
                    ]}
                  />
                </Field>
              </div>
            </>
          )}

          <Field orientation="horizontal">
            <Checkbox
              id="pm-preferred"
              checked={isPreferred}
              onCheckedChange={(v) => setIsPreferred(v === true)}
            />
            <FieldLabel htmlFor="pm-preferred">
              Preferred payment method
            </FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Add payment method'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
