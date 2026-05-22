'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
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
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from '@/components/ui/combobox';

// Shared customer picker. Searchable combobox over the active customer
// list; typing a name with no exact match surfaces a "+ Create" option
// that opens a minimal create dialog (name + type + sales rep + payment
// term + email + phone), POSTs /api/customers, and hands the new customer
// back to the caller to append + auto-select. Mirrors VendorPicker.

export type CustomerPickerOption = { id: string; code: string; name: string };
export type PaymentTermOption = { id: string; label: string };
export type SalesRepOption = { id: string; name: string };

// Subset of the POST /api/customers response the picker needs. The forms
// map this into their own CustomerOption ({ id, code, name }).
export type CreatedCustomer = { id: string; code: string; name: string };

const CUSTOMER_TYPES: Array<{ value: string; label: string }> = [
  { value: 'WHOLESALE_REGULAR', label: 'Wholesale – Regular' },
  { value: 'WHOLESALE_PREFERRED', label: 'Wholesale – Preferred' },
  { value: 'WHOLESALE_DISTRIBUTOR', label: 'Wholesale – Distributor' },
  {
    value: 'WHOLESALE_MASTER_DISTRIBUTOR',
    label: 'Wholesale – Master Distributor',
  },
  { value: 'RETAIL', label: 'Retail' },
];
const DEFAULT_TYPE = 'WHOLESALE_REGULAR';

const labelFor = (c: CustomerPickerOption) => `${c.name} (${c.code})`;

export function CustomerPicker({
  id,
  value,
  onValueChange,
  customers,
  salesReps,
  paymentTerms,
  onCreated,
  defaultSalesRepId = null,
  disabled,
  ariaInvalid,
  placeholder = 'Search customers…',
}: {
  id?: string;
  value: string | null;
  onValueChange: (id: string | null) => void;
  customers: CustomerPickerOption[];
  salesReps: SalesRepOption[];
  paymentTerms: PaymentTermOption[];
  /** Append the new customer to the parent's option list. Selection is
   * also driven via onValueChange, so the parent only needs to append. */
  onCreated: (customer: CreatedCustomer) => void;
  /** Pre-selects the sales rep in the create dialog — the current user's
   * own rep when they are one. */
  defaultSalesRepId?: string | null;
  disabled?: boolean;
  ariaInvalid?: boolean;
  placeholder?: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');

  const initial = useMemo(
    () => (value ? customers.find((c) => c.id === value) ?? null : null),
    // first render only — later external changes handled by the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [query, setQuery] = useState(initial ? labelFor(initial) : '');

  // Keep the displayed string in sync with externally-driven value
  // changes (e.g. after an inline create). Skip while the user is
  // mid-edit (value unchanged) so we never trample input.
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    if (!value) {
      setQuery('');
      return;
    }
    const c = customers.find((x) => x.id === value);
    if (c) setQuery(labelFor(c));
  }, [value, customers]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (q === '') return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [customers, trimmed]);

  const exactMatch = customers.some(
    (c) => c.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const showCreate = !disabled && trimmed !== '' && !exactMatch;

  function requestCreate(name: string) {
    setCreateName(name);
    setCreateOpen(true);
  }

  function handleCreated(created: CreatedCustomer) {
    setCreateOpen(false);
    onCreated(created);
    onValueChange(created.id);
    setQuery(`${created.name} (${created.code})`);
  }

  return (
    <>
      <Combobox<string>
        value={value || null}
        onValueChange={(v) => {
          onValueChange(v ?? null);
          const picked = v ? customers.find((x) => x.id === v) : null;
          setQuery(picked ? labelFor(picked) : '');
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(idValue) => {
          const c = customers.find((x) => x.id === idValue);
          return c ? labelFor(c) : '';
        }}
        disabled={disabled}
      >
        <ComboboxInputGroup aria-invalid={ariaInvalid}>
          <ComboboxInput id={id} placeholder={placeholder} />
          <ComboboxTrigger />
        </ComboboxInputGroup>
        <ComboboxContent>
          <ComboboxList>
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No matching customers.
              </div>
            ) : (
              filtered.map((c) => (
                <ComboboxItem key={c.id} value={c.id}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {c.code}
                    </div>
                  </div>
                </ComboboxItem>
              ))
            )}
          </ComboboxList>
          {showCreate ? (
            <>
              {filtered.length > 0 ? <ComboboxSeparator /> : null}
              <button
                type="button"
                onClick={() => requestCreate(trimmed)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
              >
                <Plus className="size-3.5" />
                Create &ldquo;{trimmed}&rdquo;
              </button>
            </>
          ) : null}
        </ComboboxContent>
      </Combobox>
      <CreateCustomerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={createName}
        salesReps={salesReps}
        paymentTerms={paymentTerms}
        defaultSalesRepId={defaultSalesRepId}
        onCreated={handleCreated}
      />
    </>
  );
}

// Minimal inline create-customer dialog. POSTs the essentials; the rest of
// the customer record (addresses, contacts, credit terms) is filled in
// later from the customer page. Does NOT self-close on success — the
// parent closes it from onCreated.
export function CreateCustomerDialog({
  open,
  onOpenChange,
  initialName,
  salesReps,
  paymentTerms,
  defaultSalesRepId = null,
  onCreated,
  description = 'Creates the customer and selects it here. You can fill in addresses, contacts, and credit terms later.',
  submitLabel = 'Create & select customer',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  salesReps: SalesRepOption[];
  paymentTerms: PaymentTermOption[];
  defaultSalesRepId?: string | null;
  onCreated: (customer: CreatedCustomer) => void;
  description?: string;
  submitLabel?: string;
}) {
  const seededRep = () =>
    defaultSalesRepId && salesReps.some((r) => r.id === defaultSalesRepId)
      ? defaultSalesRepId
      : (salesReps[0]?.id ?? '');

  const [name, setName] = useState(initialName);
  const [type, setType] = useState(DEFAULT_TYPE);
  const [salesRepId, setSalesRepId] = useState(seededRep());
  const [paymentTermId, setPaymentTermId] = useState(paymentTerms[0]?.id ?? '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed when (re)opened with a fresh typed name + current defaults.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setType(DEFAULT_TYPE);
    setSalesRepId(seededRep());
    setPaymentTermId(paymentTerms[0]?.id ?? '');
    setEmail('');
    setPhone('');
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialName, paymentTerms, salesReps, defaultSalesRepId]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!name.trim()) next.name = 'Required';
    if (!salesRepId) next.salesRepId = 'Pick a sales rep';
    if (!paymentTermId) next.paymentTermId = 'Pick a payment term';
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      next.email = 'Invalid email';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            type,
            salesRepId,
            paymentTermId,
            primaryEmail: email.trim() || undefined,
            primaryPhone: phone.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Create failed (${res.status})`);
          return;
        }
        const c = (await res.json()) as CreatedCustomer;
        toast.success(`Created customer ${c.name}.`);
        onCreated(c);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Create customer</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="cc-name">Display name</FieldLabel>
            <Input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
            />
            <FieldError
              errors={[errors.name ? { message: errors.name } : undefined]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="cc-type">Type</FieldLabel>
              <Select
                value={type}
                onValueChange={(v) => setType(v ?? DEFAULT_TYPE)}
              >
                <SelectTrigger id="cc-type" className="w-full">
                  <SelectValue>
                    {(v) =>
                      CUSTOMER_TYPES.find((t) => t.value === v)?.label ?? v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="cc-rep">Sales rep</FieldLabel>
              <Select
                value={salesRepId}
                onValueChange={(v) => setSalesRepId(v ?? '')}
              >
                <SelectTrigger
                  id="cc-rep"
                  className="w-full"
                  aria-invalid={!!errors.salesRepId}
                >
                  <SelectValue placeholder="Select…">
                    {(v) => salesReps.find((r) => r.id === v)?.name ?? 'Select…'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {salesReps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError
                errors={[
                  errors.salesRepId
                    ? { message: errors.salesRepId }
                    : undefined,
                ]}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="cc-term">Payment term</FieldLabel>
            <Select
              value={paymentTermId}
              onValueChange={(v) => setPaymentTermId(v ?? '')}
            >
              <SelectTrigger
                id="cc-term"
                className="w-full"
                aria-invalid={!!errors.paymentTermId}
              >
                <SelectValue placeholder="Select…">
                  {(v) =>
                    paymentTerms.find((t) => t.id === v)?.label ?? 'Select…'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {paymentTerms.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              errors={[
                errors.paymentTermId
                  ? { message: errors.paymentTermId }
                  : undefined,
              ]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="cc-email">Email (optional)</FieldLabel>
              <Input
                id="cc-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!errors.email}
              />
              <FieldError
                errors={[errors.email ? { message: errors.email } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cc-phone">Phone (optional)</FieldLabel>
              <Input
                id="cc-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Creating…' : submitLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
