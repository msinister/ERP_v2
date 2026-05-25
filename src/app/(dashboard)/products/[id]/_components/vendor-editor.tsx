'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Pencil, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  CreateVendorDialog,
  type CreatedVendor,
} from '@/components/shared/vendor-picker';

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
  async function onVendorCreated(created: CreatedVendor) {
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
      description="Creates the vendor and sets it as this product's primary vendor. You can fill in the rest of the vendor record later."
      submitLabel="Create & set vendor"
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
