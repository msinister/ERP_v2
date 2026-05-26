'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import Link from 'next/link';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

// ===========================================================================
// Form schema
// ---------------------------------------------------------------------------
// Mirrors productCreateSchema but carries '' as the "no value" sentinel
// because RHF + native inputs always produce strings. On submit we map
// empty strings to undefined so the API zod accepts them as optional.
// ===========================================================================

const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'ASSEMBLED', label: 'Assembled' },
  { value: 'BUNDLE', label: 'Bundle' },
  { value: 'DROP_SHIP', label: 'Drop-ship' },
  { value: 'SERVICE', label: 'Service' },
] as const;

const WEIGHT_UNITS = ['oz', 'lb', 'kg', 'g'] as const;
const DIMENSION_UNITS = ['in', 'mm', 'cm'] as const;

const productTypeEnum = z.enum([
  'SIMPLE',
  'ASSEMBLED',
  'BUNDLE',
  'DROP_SHIP',
  'SERVICE',
]);
const weightUnitEnum = z.enum(WEIGHT_UNITS);
const dimensionUnitEnum = z.enum(DIMENSION_UNITS);

// Accept leading-dot decimals (.5, .15) in addition to the conventional
// `0.5` form — common shorthand in inventory data entry.
const nonNegDecimal = z
  .union([
    z.literal(''),
    z
      .string()
      .regex(/^(\d+(\.\d+)?|\.\d+)$/, 'Must be a non-negative decimal'),
  ])
  .optional();

const formSchema = z.object({
  sku: z.string().min(1, 'Required').max(64),
  name: z.string().min(1, 'Required').max(255),
  type: productTypeEnum,
  brand: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  manufacturerPartNumber: z.string().max(120).optional(),
  basePrice: nonNegDecimal,
  tracksInventory: z.boolean(),
  active: z.boolean(),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().optional(),
  weight: nonNegDecimal,
  weightUnit: weightUnitEnum,
  lengthDim: nonNegDecimal,
  widthDim: nonNegDecimal,
  heightDim: nonNegDecimal,
  dimensionUnit: dimensionUnitEnum,
  countryOfOrigin: z.string().max(120).optional(),
  hsCode: z.string().max(64).optional(),
  hazmat: z.boolean(),
});

export type ProductFormValues = z.infer<typeof formSchema>;

export type ProductFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; productId: string };

const DEFAULT_VALUES: ProductFormValues = {
  sku: '',
  name: '',
  type: 'SIMPLE',
  brand: '',
  category: '',
  manufacturerPartNumber: '',
  basePrice: '',
  tracksInventory: true,
  active: true,
  shortDescription: '',
  longDescription: '',
  weight: '',
  weightUnit: 'lb',
  lengthDim: '',
  widthDim: '',
  heightDim: '',
  dimensionUnit: 'in',
  countryOfOrigin: '',
  hsCode: '',
  hazmat: false,
};

function nullEmpty(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

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

export function ProductForm({
  mode,
  defaultValues,
}: {
  mode: ProductFormMode;
  defaultValues?: Partial<ProductFormValues>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const submitLabel = mode.kind === 'create' ? 'Create product' : 'Save changes';

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
  });
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = form;

  function submit(values: ProductFormValues) {
    startTransition(async () => {
      const sku = values.sku.trim();
      const payload: Record<string, unknown> = {
        sku,
        name: values.name.trim(),
        type: values.type,
        brand: nullEmpty(values.brand),
        category: nullEmpty(values.category),
        manufacturerPartNumber: nullEmpty(values.manufacturerPartNumber),
        basePrice: nullEmpty(values.basePrice),
        tracksInventory: values.tracksInventory,
        active: values.active,
        shortDescription: nullEmpty(values.shortDescription),
        longDescription: nullEmpty(values.longDescription),
        weight: nullEmpty(values.weight),
        weightUnit: values.weightUnit,
        lengthDim: nullEmpty(values.lengthDim),
        widthDim: nullEmpty(values.widthDim),
        heightDim: nullEmpty(values.heightDim),
        dimensionUnit: values.dimensionUnit,
        countryOfOrigin: nullEmpty(values.countryOfOrigin),
        hsCode: nullEmpty(values.hsCode),
        hazmat: values.hazmat,
      };
      // Always seed a default variant on create so the product appears
      // in order-entry SKU dropdowns (which query ProductVariant, not Product).
      if (mode.kind === 'create') {
        payload.defaultVariant = { sku };
      }
      try {
        const endpoint =
          mode.kind === 'create'
            ? '/api/products'
            : `/api/products/${mode.productId}`;
        const method = mode.kind === 'create' ? 'POST' : 'PUT';
        // SKU is immutable post-create in practice — strip it from the
        // PUT body so an accidental edit doesn't collide with another
        // product's SKU. The PUT route's zod allows it via .partial()
        // but operators shouldn't rebrand SKUs through the form.
        const body =
          mode.kind === 'create'
            ? payload
            : (() => {
                const { sku: _sku, ...rest } = payload;
                void _sku;
                return rest;
              })();
        const res = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        const saved = (await res.json()) as { id: string; name: string };
        toast.success(
          mode.kind === 'create'
            ? `Created ${saved.name}`
            : `Saved ${saved.name}`,
        );
        router.push(`/products/${saved.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sku">SKU</FieldLabel>
                <Input
                  id="sku"
                  aria-invalid={!!errors.sku}
                  className="font-mono"
                  disabled={mode.kind === 'edit'}
                  {...register('sku')}
                />
                <FieldError errors={[errors.sku]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="type">Type</FieldLabel>
                <Controller
                  control={control}
                  name="type"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="type" className="w-full">
                        <SelectValue>
                          {(v) =>
                            PRODUCT_TYPES.find((t) => t.value === v)?.label ??
                            v
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
                  )}
                />
                <FieldError errors={[errors.type]} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                aria-invalid={!!errors.name}
                {...register('name')}
              />
              <FieldError errors={[errors.name]} />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="brand">Brand</FieldLabel>
              <Input
                id="brand"
                aria-invalid={!!errors.brand}
                {...register('brand')}
              />
              <FieldError errors={[errors.brand]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="category">Category</FieldLabel>
              <Input
                id="category"
                aria-invalid={!!errors.category}
                {...register('category')}
              />
              <FieldError errors={[errors.category]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="manufacturerPartNumber">MPN</FieldLabel>
              <Input
                id="manufacturerPartNumber"
                className="font-mono"
                aria-invalid={!!errors.manufacturerPartNumber}
                {...register('manufacturerPartNumber')}
              />
              <FieldError errors={[errors.manufacturerPartNumber]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="basePrice">
                Base price (USD, blank = none)
              </FieldLabel>
              <Input
                id="basePrice"
                inputMode="decimal"
                placeholder="0.00"
                aria-invalid={!!errors.basePrice}
                {...register('basePrice')}
              />
              <FieldError errors={[errors.basePrice]} />
            </Field>
            <Field orientation="horizontal" className="md:items-start md:pt-2">
              <Controller
                control={control}
                name="tracksInventory"
                render={({ field }) => (
                  <Checkbox
                    id="tracksInventory"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                )}
              />
              <FieldLabel htmlFor="tracksInventory">
                Tracks inventory
              </FieldLabel>
            </Field>
            <Field orientation="horizontal" className="md:items-start md:pt-2">
              <Controller
                control={control}
                name="active"
                render={({ field }) => (
                  <Checkbox
                    id="active"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                )}
              />
              <FieldLabel htmlFor="active">Active</FieldLabel>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Description</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="shortDescription">
                Short description
              </FieldLabel>
              <Input
                id="shortDescription"
                aria-invalid={!!errors.shortDescription}
                {...register('shortDescription')}
              />
              <FieldError errors={[errors.shortDescription]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="longDescription">Long description</FieldLabel>
              <Textarea
                id="longDescription"
                rows={5}
                aria-invalid={!!errors.longDescription}
                {...register('longDescription')}
              />
              <FieldError errors={[errors.longDescription]} />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Dimensions &amp; weight</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="weight">Weight</FieldLabel>
                <Input
                  id="weight"
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={!!errors.weight}
                  {...register('weight')}
                />
                <FieldError errors={[errors.weight]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="weightUnit">Weight unit</FieldLabel>
                <Controller
                  control={control}
                  name="weightUnit"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="weightUnit" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEIGHT_UNITS.map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.weightUnit]} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="lengthDim">Length</FieldLabel>
                <Input
                  id="lengthDim"
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={!!errors.lengthDim}
                  {...register('lengthDim')}
                />
                <FieldError errors={[errors.lengthDim]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="widthDim">Width</FieldLabel>
                <Input
                  id="widthDim"
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={!!errors.widthDim}
                  {...register('widthDim')}
                />
                <FieldError errors={[errors.widthDim]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="heightDim">Height</FieldLabel>
                <Input
                  id="heightDim"
                  inputMode="decimal"
                  placeholder="0"
                  aria-invalid={!!errors.heightDim}
                  {...register('heightDim')}
                />
                <FieldError errors={[errors.heightDim]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="dimensionUnit">Dimension unit</FieldLabel>
                <Controller
                  control={control}
                  name="dimensionUnit"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="dimensionUnit" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DIMENSION_UNITS.map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.dimensionUnit]} />
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Compliance</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="countryOfOrigin">
                  Country of origin
                </FieldLabel>
                <Input
                  id="countryOfOrigin"
                  aria-invalid={!!errors.countryOfOrigin}
                  {...register('countryOfOrigin')}
                />
                <FieldError errors={[errors.countryOfOrigin]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="hsCode">HS code</FieldLabel>
                <Input
                  id="hsCode"
                  className="font-mono"
                  aria-invalid={!!errors.hsCode}
                  {...register('hsCode')}
                />
                <FieldError errors={[errors.hsCode]} />
              </Field>
              <Field orientation="horizontal" className="md:items-start md:pt-2">
                <Controller
                  control={control}
                  name="hazmat"
                  render={({ field }) => (
                    <Checkbox
                      id="hazmat"
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(v === true)}
                    />
                  )}
                />
                <FieldLabel htmlFor="hazmat">Hazmat</FieldLabel>
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          render={
            <Link
              href={
                mode.kind === 'create'
                  ? '/products'
                  : `/products/${mode.productId}`
              }
            />
          }
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
