'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
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
import { normalizeDecimalForSubmit } from '@/lib/decimal-input';

export type VariantOption = {
  id: string;
  sku: string;
  variantName: string | null;
  productName: string;
};

export type ProductFormDialogProduct = {
  id: string;
  variantId: string;
  variantLabel: string;
  vendorSku: string | null;
  latestCost: string | null;
  packSize: string | null;
  isPrimary: boolean;
  active: boolean;
  notes: string | null;
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

// Permissive shape — accept ".25" alongside "0.25". The submit path
// normalizes via normalizeDecimalForSubmit before the fetch so the
// server's strict decimalString validator gets the canonical form.
const POSITIVE_DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;

// Shared add + edit dialog for the vendor product catalog. Variant is
// fixed on edit — changing it would mean deleting one row and creating
// another (the service enforces (vendor, variant) uniqueness).
export function ProductFormDialog({
  vendorId,
  variants,
  existingVariantIds,
  product,
  open,
  onOpenChange,
}: {
  vendorId: string;
  variants: VariantOption[];
  existingVariantIds: ReadonlySet<string>;
  product: ProductFormDialogProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [variantId, setVariantId] = useState('');
  const [vendorSku, setVendorSku] = useState('');
  const [latestCost, setLatestCost] = useState('');
  const [packSize, setPackSize] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (product) {
      setVariantId(product.variantId);
      setVendorSku(product.vendorSku ?? '');
      setLatestCost(product.latestCost ?? '');
      setPackSize(product.packSize ?? '');
      setIsPrimary(product.isPrimary);
      setActive(product.active);
      setNotes(product.notes ?? '');
    } else {
      setVariantId('');
      setVendorSku('');
      setLatestCost('');
      setPackSize('');
      setIsPrimary(false);
      setActive(true);
      setNotes('');
    }
  }, [open, product]);

  const isEdit = product != null;

  // On create, hide variants that already have a non-deleted row for
  // this vendor — the service rejects duplicates anyway, but the UX is
  // nicer to never offer the option. On edit, the row's current variant
  // stays in the list so the label renders correctly.
  const availableVariants = useMemo(() => {
    if (isEdit) return variants;
    return variants.filter((v) => !existingVariantIds.has(v.id));
  }, [variants, existingVariantIds, isEdit]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (!isEdit && variantId.trim() === '') next.variantId = 'Required';
    if (latestCost && !POSITIVE_DECIMAL_RE.test(latestCost))
      next.latestCost = 'Must be a positive number';
    else if (latestCost && Number(latestCost) <= 0)
      next.latestCost = 'Must be greater than 0';
    if (packSize && !POSITIVE_DECIMAL_RE.test(packSize))
      next.packSize = 'Must be a positive number';
    else if (packSize && Number(packSize) <= 0)
      next.packSize = 'Must be greater than 0';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    // Create requires variantId; edit doesn't accept it (immutable).
    // Normalize loose decimal input (".25" → "0.25") so the server's
    // strict validator accepts the value.
    const trimmedCost = latestCost.trim();
    const trimmedPack = packSize.trim();
    const createPayload = {
      variantId,
      vendorSku: vendorSku.trim() || undefined,
      latestCost: trimmedCost ? normalizeDecimalForSubmit(trimmedCost) : undefined,
      packSize: trimmedPack ? normalizeDecimalForSubmit(trimmedPack) : undefined,
      isPrimary,
      active,
      notes: notes.trim() || undefined,
    };
    const editPayload = (() => {
      const { variantId: _v, ...rest } = createPayload;
      void _v;
      return rest;
    })();
    startTransition(async () => {
      try {
        const url = isEdit
          ? `/api/vendors/${vendorId}/products/${product.id}`
          : `/api/vendors/${vendorId}/products`;
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
        toast.success(isEdit ? 'Saved catalog row' : 'Added catalog row');
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
            {isEdit ? 'Edit catalog row' : 'Add catalog row'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Per-vendor per-variant SKU + cost. Marking primary unsets any
            other primary vendor for this variant.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="vp-variant">Variant</FieldLabel>
            {isEdit ? (
              <Input
                id="vp-variant"
                value={product.variantLabel}
                readOnly
                disabled
                className="font-mono"
              />
            ) : (
              <Select
                value={variantId}
                onValueChange={(v) => setVariantId(v ?? '')}
              >
                <SelectTrigger
                  id="vp-variant"
                  className="w-full"
                  aria-invalid={!!errors.variantId}
                >
                  <SelectValue placeholder="Pick a variant…">
                    {(value) => {
                      if (!value) return null;
                      const variant = variants.find((x) => x.id === value);
                      if (!variant) return value;
                      return (
                        <>
                          <span className="font-mono">{variant.sku}</span> —{' '}
                          {variant.productName}
                          {variant.variantName
                            ? ` · ${variant.variantName}`
                            : ''}
                        </>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableVariants.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      Every active variant is already in this vendor&apos;s
                      catalog.
                    </div>
                  ) : (
                    availableVariants.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        <span className="font-mono">{v.sku}</span> —{' '}
                        {v.productName}
                        {v.variantName ? ` · ${v.variantName}` : ''}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
            <FieldError
              errors={[errors.variantId ? { message: errors.variantId } : undefined]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vp-sku">Vendor SKU (optional)</FieldLabel>
            <Input
              id="vp-sku"
              value={vendorSku}
              onChange={(e) => setVendorSku(e.target.value)}
              className="font-mono"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="vp-cost">Latest cost</FieldLabel>
              <Input
                id="vp-cost"
                inputMode="decimal"
                placeholder="0.00"
                value={latestCost}
                onChange={(e) => setLatestCost(e.target.value)}
                aria-invalid={!!errors.latestCost}
              />
              <FieldError
                errors={[errors.latestCost ? { message: errors.latestCost } : undefined]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="vp-pack">Pack size</FieldLabel>
              <Input
                id="vp-pack"
                inputMode="decimal"
                placeholder="1"
                value={packSize}
                onChange={(e) => setPackSize(e.target.value)}
                aria-invalid={!!errors.packSize}
              />
              <FieldError
                errors={[errors.packSize ? { message: errors.packSize } : undefined]}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="vp-notes">Notes (optional)</FieldLabel>
            <Input
              id="vp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field orientation="horizontal">
              <Checkbox
                id="vp-primary"
                checked={isPrimary}
                onCheckedChange={(v) => setIsPrimary(v === true)}
              />
              <FieldLabel htmlFor="vp-primary">
                Primary for this variant
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="vp-active"
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
              />
              <FieldLabel htmlFor="vp-active">Active</FieldLabel>
            </Field>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={
              pending ||
              (!isEdit && availableVariants.length === 0) ||
              (!isEdit && variantId.trim() === '')
            }
          >
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add row'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
