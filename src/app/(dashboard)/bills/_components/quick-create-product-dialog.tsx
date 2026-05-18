'use client';

import { useEffect, useState, useTransition } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import type { VariantOption } from './bill-form';

const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
  { value: 'SERVICE', label: 'Service' },
] as const;

type ProductType = (typeof PRODUCT_TYPES)[number]['value'];

// Accept leading-dot decimals (.5, .15) — same shorthand the product form
// accepts. Empty = no base price.
const BASE_PRICE_PATTERN = /^(\d+(\.\d+)?|\.\d+)$/;

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

type CreateProductResponse = {
  id: string;
  sku: string;
  name: string;
  defaultVariant: {
    id: string;
    sku: string;
    name: string | null;
  } | null;
};

// Inline product create reachable from the bill-line variant combobox.
// Captures the minimum needed to make the new product immediately usable
// on a bill line: product SKU + name, optional base price, and product
// type (defaults to SIMPLE — the only type that holds inventory in the
// pilot). createProduct seeds a default variant atomically (same SKU as
// the product unless overridden) so the bill picker, which keys off
// variant.id, has something to select.
export function QuickCreateProductDialog({
  open,
  onOpenChange,
  initialQuery,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Whatever the operator typed into the combobox before opening the
   * dialog. Pre-fills SKU when it looks SKU-ish (no spaces, ≤64 chars),
   * else pre-fills Name. Operator can edit either before submitting.
   */
  initialQuery: string;
  onCreated: (variant: VariantOption) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [type, setType] = useState<ProductType>('SIMPLE');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setBasePrice('');
    setType('SIMPLE');
    const q = initialQuery.trim();
    const looksLikeSku = q.length > 0 && q.length <= 64 && !/\s/.test(q);
    setSku(looksLikeSku ? q : '');
    setName(looksLikeSku ? '' : q);
  }, [open, initialQuery]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    const skuTrim = sku.trim();
    const nameTrim = name.trim();
    if (skuTrim === '') next.sku = 'Required';
    else if (skuTrim.length > 64) next.sku = 'Max 64 characters';
    if (nameTrim === '') next.name = 'Required';
    else if (nameTrim.length > 255) next.name = 'Max 255 characters';
    if (basePrice.trim() !== '' && !BASE_PRICE_PATTERN.test(basePrice.trim())) {
      next.basePrice = 'Must be a non-negative decimal';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});

    const payload: Record<string, unknown> = {
      sku: skuTrim,
      name: nameTrim,
      type,
      defaultVariant: { sku: skuTrim },
    };
    const priceTrim = basePrice.trim();
    if (priceTrim !== '') payload.basePrice = priceTrim;

    startTransition(async () => {
      try {
        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const created = (await res.json()) as CreateProductResponse;
        if (!created.defaultVariant) {
          // Belt-and-braces guard: the API contract guarantees this when
          // we send `defaultVariant`, but if a future change drops the
          // seed we'd otherwise silently fail to add anything to the
          // picker. Surface it instead of swallowing.
          toast.error('Product created but no default variant returned');
          return;
        }
        toast.success(`Created ${created.name}`);
        onCreated({
          id: created.defaultVariant.id,
          sku: created.defaultVariant.sku,
          variantName: created.defaultVariant.name,
          productName: created.name,
          // Quick-create doesn't capture a shortDescription — passes
          // null so the variant appears in the picker immediately.
          // Operator can edit the product later to add one.
          shortDescription: null,
        });
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Create product</AlertDialogTitle>
          <AlertDialogDescription>
            Adds a product and one default variant. You can flesh out the
            rest from the product page later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="qc-sku">SKU</FieldLabel>
            <Input
              id="qc-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              aria-invalid={!!errors.sku}
              className="font-mono"
              autoFocus
            />
            <FieldError
              errors={[errors.sku ? { message: errors.sku } : undefined]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="qc-name">Name</FieldLabel>
            <Input
              id="qc-name"
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
              <FieldLabel htmlFor="qc-type">Type</FieldLabel>
              <Select
                value={type}
                onValueChange={(v) => setType(v as ProductType)}
              >
                <SelectTrigger id="qc-type" className="w-full">
                  <SelectValue>
                    {(v) =>
                      PRODUCT_TYPES.find((t) => t.value === v)?.label ?? v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="qc-base-price">
                Base price (optional)
              </FieldLabel>
              <Input
                id="qc-base-price"
                inputMode="decimal"
                placeholder="0.00"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                aria-invalid={!!errors.basePrice}
              />
              <FieldError
                errors={[
                  errors.basePrice ? { message: errors.basePrice } : undefined,
                ]}
              />
            </Field>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Creating…' : 'Create product'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
