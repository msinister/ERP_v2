'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
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
import { Checkbox } from '@/components/ui/checkbox';
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

// Shared vendor picker. Searchable combobox over the active vendor list;
// typing a name with no exact match surfaces a "+ Create" option that
// opens a minimal create dialog (name + type + payment term + active),
// POSTs /api/vendors, and hands the new vendor back to the caller to
// append + auto-select. Mirrors the product Overview vendor picker, made
// form-friendly (bound to value/onValueChange instead of save-on-select).

export type VendorPickerOption = { id: string; code: string; name: string };
export type PaymentTermOption = { id: string; label: string };

// Full shape returned by POST /api/vendors (a Prisma Vendor row). The
// picker hands this straight back to the parent's onCreated so each
// form maps it into its own VendorOption (PO needs type + currency,
// Bill/VC need currency).
export type CreatedVendor = {
  id: string;
  code: string;
  name: string;
  type: 'STOCK' | 'DROP_SHIP' | 'SERVICE';
  defaultCurrency: string | null;
};

const labelFor = (v: VendorPickerOption) => `${v.name} (${v.code})`;

export function VendorPicker({
  id,
  value,
  onValueChange,
  vendors,
  paymentTerms,
  onCreated,
  disabled,
  ariaInvalid,
  placeholder = 'Search vendors…',
}: {
  id?: string;
  value: string | null;
  onValueChange: (id: string | null) => void;
  vendors: VendorPickerOption[];
  paymentTerms: PaymentTermOption[];
  /** Called after a successful inline create — the parent should append
   * the vendor to its option list. Selection is also driven via
   * onValueChange, so the parent doesn't need to select here. */
  onCreated: (vendor: CreatedVendor) => void;
  disabled?: boolean;
  ariaInvalid?: boolean;
  placeholder?: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');

  const initial = useMemo(
    () => (value ? vendors.find((v) => v.id === value) ?? null : null),
    // first render only — later external changes handled by the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [query, setQuery] = useState(initial ? labelFor(initial) : '');

  // Keep the displayed string in sync with externally-driven value
  // changes (e.g. parent setValue after an inline create). Skip when
  // the user is mid-edit (value unchanged) so we never trample input.
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    if (!value) {
      setQuery('');
      return;
    }
    const v = vendors.find((x) => x.id === value);
    if (v) setQuery(labelFor(v));
  }, [value, vendors]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (q === '') return vendors;
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.code.toLowerCase().includes(q),
    );
  }, [vendors, trimmed]);

  // Offer create only when there's a typed name with no exact name
  // match — and never on a disabled (read-only) picker.
  const exactMatch = vendors.some(
    (v) => v.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const showCreate = !disabled && trimmed !== '' && !exactMatch;

  function requestCreate(name: string) {
    setCreateName(name);
    setCreateOpen(true);
  }

  function handleCreated(created: CreatedVendor) {
    setCreateOpen(false);
    // Parent appends to its option list first, then we select — by the
    // next render the new vendor is present and the value effect sets
    // the input to its label. Set eagerly too so there's no flash.
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
          const picked = v ? vendors.find((x) => x.id === v) : null;
          setQuery(picked ? labelFor(picked) : '');
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(idValue) => {
          const v = vendors.find((x) => x.id === idValue);
          return v ? labelFor(v) : '';
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
                No matching vendors.
              </div>
            ) : (
              filtered.map((v) => (
                <ComboboxItem key={v.id} value={v.id}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{v.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {v.code}
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
      <CreateVendorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={createName}
        paymentTerms={paymentTerms}
        onCreated={handleCreated}
      />
    </>
  );
}

// SERVICE is intentionally omitted: the contexts that use this picker
// (product primary vendor, PO/Bill/VC entry) all want a purchasable
// vendor. SERVICE vendors are AP-only and offering the option here only
// creates confusion.
const VENDOR_TYPES: Array<{ value: string; label: string }> = [
  { value: 'STOCK', label: 'Stock' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
];

// Minimal inline create-vendor dialog. Shared by the product Overview
// vendor editor and the VendorPicker above. POSTs the essentials; the
// rest of the vendor record is filled in later from the vendor page.
// Does NOT self-close on success — the parent closes it from onCreated,
// so both callers control the open state consistently.
export function CreateVendorDialog({
  open,
  onOpenChange,
  initialName,
  paymentTerms,
  onCreated,
  description = 'Creates the vendor and selects it here. You can fill in the rest of the vendor record later.',
  submitLabel = 'Create & select vendor',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  paymentTerms: PaymentTermOption[];
  onCreated: (vendor: CreatedVendor) => void;
  description?: string;
  submitLabel?: string;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState('STOCK');
  const [paymentTermId, setPaymentTermId] = useState(paymentTerms[0]?.id ?? '');
  const [active, setActive] = useState(true);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed when (re)opened with a fresh typed name.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setType('STOCK');
    setPaymentTermId(paymentTerms[0]?.id ?? '');
    setActive(true);
    setErrors({});
  }, [open, initialName, paymentTerms]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!name.trim()) next.name = 'Required';
    if (!paymentTermId) next.paymentTermId = 'Pick a payment term';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/vendors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            type,
            paymentTermId,
            active,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Create failed (${res.status})`);
          return;
        }
        const v = (await res.json()) as CreatedVendor;
        toast.success(`Created vendor ${v.name}.`);
        onCreated(v);
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
          <AlertDialogTitle>Create vendor</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="cv-name">Vendor name</FieldLabel>
            <Input
              id="cv-name"
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
              <FieldLabel htmlFor="cv-type">Type</FieldLabel>
              <Select value={type} onValueChange={(v) => setType(v ?? 'STOCK')}>
                <SelectTrigger id="cv-type" className="w-full">
                  <SelectValue>
                    {(v) => VENDOR_TYPES.find((t) => t.value === v)?.label ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {VENDOR_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="cv-term">Payment term</FieldLabel>
              <Select
                value={paymentTermId}
                onValueChange={(v) => setPaymentTermId(v ?? '')}
              >
                <SelectTrigger
                  id="cv-term"
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
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="cv-active"
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            <FieldLabel htmlFor="cv-active">Active</FieldLabel>
          </Field>
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
