'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil, Plus, X } from 'lucide-react';
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

export type VendorOption = { id: string; code: string; name: string };
export type PaymentTermOption = { id: string; label: string };

// Inline primary-vendor editor for the product Overview tab. Read view
// shows the current vendor (link) + pencil, or "No vendor assigned" with
// a "+ Set vendor" button. Editing opens a searchable combobox; selecting
// saves immediately via PATCH; a Clear button unsets the primary vendor.
// Typing an unknown name surfaces a "+ Create" option that opens a
// minimal create dialog, then auto-selects the new vendor.
export function VendorEditor({
  productId,
  initialVendor,
  vendors,
  paymentTerms,
}: {
  productId: string;
  initialVendor: { id: string; name: string } | null;
  vendors: VendorOption[];
  paymentTerms: PaymentTermOption[];
}) {
  const router = useRouter();
  const [vendor, setVendor] = useState(initialVendor);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');

  useEffect(() => {
    setVendor(initialVendor);
  }, [initialVendor]);

  async function save(vendorId: string | null) {
    setPending(true);
    try {
      const res = await fetch(`/api/products/${productId}/primary-vendor`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? `Save failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        vendor: { vendorId: string; vendorName: string } | null;
      };
      setVendor(
        data.vendor
          ? { id: data.vendor.vendorId, name: data.vendor.vendorName }
          : null,
      );
      setEditing(false);
      toast.success(data.vendor ? 'Primary vendor updated.' : 'Vendor cleared.');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  function requestCreate(name: string) {
    setCreateName(name);
    setCreateOpen(true);
  }

  // New vendor created → set it as the product's primary vendor.
  async function onVendorCreated(created: { id: string; name: string }) {
    setCreateOpen(false);
    await save(created.id);
  }

  const createDialog = (
    <CreateVendorDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      initialName={createName}
      paymentTerms={paymentTerms}
      onCreated={onVendorCreated}
    />
  );

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <VendorCombobox
          vendors={vendors}
          value={vendor?.id ?? null}
          disabled={pending}
          onSelect={(id) => save(id)}
          onCreateRequest={requestCreate}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
        {createDialog}
      </div>
    );
  }

  if (!vendor) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setEditing(true)}
        >
          <Plus />
          Set vendor
        </Button>
        {createDialog}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/vendors/${vendor.id}`}
        className="font-medium text-primary hover:underline"
      >
        {vendor.name}
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Edit vendor"
        disabled={pending}
        onClick={() => setEditing(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear vendor"
        disabled={pending}
        onClick={() => save(null)}
      >
        <X className="size-3.5" />
      </Button>
      {createDialog}
    </div>
  );
}

function VendorCombobox({
  vendors,
  value,
  disabled,
  onSelect,
  onCreateRequest,
}: {
  vendors: VendorOption[];
  value: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreateRequest: (name: string) => void;
}) {
  const labelFor = (v: VendorOption) => `${v.name} (${v.code})`;
  const initial = useMemo(
    () => (value ? vendors.find((v) => v.id === value) ?? null : null),
    // first render only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [query, setQuery] = useState(initial ? labelFor(initial) : '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (q === '') return vendors;
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.code.toLowerCase().includes(q),
    );
  }, [vendors, trimmed]);

  // Offer create only when there's a typed name with no exact name match.
  const exactMatch = vendors.some(
    (v) => v.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const showCreate = trimmed !== '' && !exactMatch;

  return (
    <Combobox<string>
      value={value || null}
      onValueChange={(v) => {
        if (v) onSelect(v);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(idValue) => {
        const v = vendors.find((x) => x.id === idValue);
        return v ? labelFor(v) : '';
      }}
      disabled={disabled}
    >
      <ComboboxInputGroup className="w-64">
        <ComboboxInput ref={inputRef} placeholder="Search vendors…" />
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
              onClick={() => onCreateRequest(trimmed)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
            >
              <Plus className="size-3.5" />
              Create &ldquo;{trimmed}&rdquo;
            </button>
          </>
        ) : null}
      </ComboboxContent>
    </Combobox>
  );
}

// SERVICE is intentionally omitted: service vendors can't be a product's
// primary/catalog vendor (blocked at the service layer), so offering it
// here — where the whole point is setting the primary vendor — only
// creates confusion.
const VENDOR_TYPES: Array<{ value: string; label: string }> = [
  { value: 'STOCK', label: 'Stock' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
];

function CreateVendorDialog({
  open,
  onOpenChange,
  initialName,
  paymentTerms,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  paymentTerms: PaymentTermOption[];
  onCreated: (vendor: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState('STOCK');
  const [paymentTermId, setPaymentTermId] = useState(
    paymentTerms[0]?.id ?? '',
  );
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
        const v = (await res.json()) as { id: string; name: string };
        toast.success(`Created vendor ${v.name}.`);
        onCreated({ id: v.id, name: v.name });
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
          <AlertDialogDescription>
            Creates the vendor and sets it as this product&apos;s primary
            vendor. You can fill in the rest of the vendor record later.
          </AlertDialogDescription>
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
                    {(v) =>
                      VENDOR_TYPES.find((t) => t.value === v)?.label ?? v
                    }
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
            {pending ? 'Creating…' : 'Create & set vendor'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
