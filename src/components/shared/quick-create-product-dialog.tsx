'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
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

const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
  { value: 'SERVICE', label: 'Service' },
] as const;

type ProductType = (typeof PRODUCT_TYPES)[number]['value'];

// Sentinel for the "no category" option — base-ui Select can't carry an
// empty-string item value, so we map this back to '' on submit.
const CATEGORY_NONE = '__none__';

// Accept leading-dot decimals (.5, .15) — same shorthand the product form
// accepts. Empty = no base price.
const BASE_PRICE_PATTERN = /^(\d+(\.\d+)?|\.\d+)$/;

// Rich payload handed back on a successful create. Carries everything the
// various line forms need to build their own variant-option shape (PO/Bill
// key off variantId; SO/CM also want basePrice). The picker maps this into
// a VariantPickerOption internally for immediate selection.
export type CreatedProduct = {
  productId: string;
  variantId: string;
  sku: string;
  variantName: string | null;
  productName: string;
  shortDescription: string | null;
  basePrice: string | null;
  type: string;
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

type CreateProductResponse = {
  id: string;
  name: string;
  shortDescription: string | null;
  basePrice: string | null;
  type: string;
  defaultVariant: {
    id: string;
    sku: string;
    name: string | null;
  } | null;
};

// Inline product create reachable from any VariantPicker (SKU selector).
// Captures the minimum needed to make the new product immediately usable
// on a line: SKU + name, optional base price, product type (defaults to
// SIMPLE — the only type that holds inventory in the pilot), and optional
// category (dropdown from existing values) + brand. createProduct seeds a
// default variant atomically (same SKU as the product) so the picker,
// which keys off variant.id, has something to select.
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
  onCreated: (created: CreatedProduct) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [type, setType] = useState<ProductType>('SIMPLE');
  const [category, setCategory] = useState(CATEGORY_NONE);
  const [brand, setBrand] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Existing categories for the dropdown — fetched once on first open
  // and cached. Failure is non-fatal: the dropdown just shows "None".
  const [categories, setCategories] = useState<string[]>([]);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setBasePrice('');
    setType('SIMPLE');
    setCategory(CATEGORY_NONE);
    setBrand('');
    const q = initialQuery.trim();
    const looksLikeSku = q.length > 0 && q.length <= 64 && !/\s/.test(q);
    setSku(looksLikeSku ? q : '');
    setName(looksLikeSku ? '' : q);

    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/products/categories');
        if (!res.ok) return;
        const body = (await res.json()) as { categories?: string[] };
        setCategories(body.categories ?? []);
      } catch {
        // Non-fatal — leave the dropdown empty (None only).
      }
    })();
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
    if (category !== CATEGORY_NONE) payload.category = category;
    const brandTrim = brand.trim();
    if (brandTrim !== '') payload.brand = brandTrim;

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
          // Belt-and-braces: the API guarantees this when we send
          // `defaultVariant`, but surface it rather than silently
          // failing to add anything to the picker.
          toast.error('Product created but no default variant returned');
          return;
        }
        toast.success(`Created ${created.name}`);
        onCreated({
          productId: created.id,
          variantId: created.defaultVariant.id,
          sku: created.defaultVariant.sku,
          variantName: created.defaultVariant.name,
          productName: created.name,
          shortDescription: created.shortDescription ?? null,
          basePrice:
            created.basePrice != null ? String(created.basePrice) : null,
          type: created.type,
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
            Adds a product and one default variant, then selects it on this
            line. You can flesh out the rest from the product page later.
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
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="qc-category">Category (optional)</FieldLabel>
              <Select value={category} onValueChange={(v) => setCategory(v ?? CATEGORY_NONE)}>
                <SelectTrigger id="qc-category" className="w-full">
                  <SelectValue>
                    {(v) => (v === CATEGORY_NONE || !v ? 'None' : v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CATEGORY_NONE}>None</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="qc-brand">Brand (optional)</FieldLabel>
              <Input
                id="qc-brand"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Acme"
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
