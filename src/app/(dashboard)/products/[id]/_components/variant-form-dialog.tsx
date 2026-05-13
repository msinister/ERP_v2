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

export type VariantFormDialogVariant = {
  id: string;
  sku: string;
  name: string | null;
  variantGroup: string | null;
  color: string | null;
  flavor: string | null;
  size: string | null;
  active: boolean;
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

// Shared add + edit dialog. When `variant` is null we POST to
// /api/products/[productId]/variants; otherwise PUT to
// /api/variants/[id]. Backend creates+updates use the same shape
// minus productId (which the POST route injects from the URL).
export function VariantFormDialog({
  productId,
  productSku,
  variant,
  open,
  onOpenChange,
}: {
  productId: string;
  productSku: string;
  variant: VariantFormDialogVariant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [variantGroup, setVariantGroup] = useState('');
  const [color, setColor] = useState('');
  const [flavor, setFlavor] = useState('');
  const [size, setSize] = useState('');
  const [active, setActive] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // Re-seed local form state when the dialog opens (so re-opening for
  // a different variant doesn't carry stale values).
  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (variant) {
      setSku(variant.sku);
      setName(variant.name ?? '');
      setVariantGroup(variant.variantGroup ?? '');
      setColor(variant.color ?? '');
      setFlavor(variant.flavor ?? '');
      setSize(variant.size ?? '');
      setActive(variant.active);
    } else {
      // Sensible default for the first/only variant: same SKU as parent
      // product. Operator can edit before saving if they want a suffix.
      setSku(productSku);
      setName('');
      setVariantGroup('');
      setColor('');
      setFlavor('');
      setSize('');
      setActive(true);
    }
  }, [open, variant, productSku]);

  function submit() {
    const next: Partial<Record<string, string>> = {};
    if (sku.trim() === '') next.sku = 'Required';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    const payload = {
      sku: sku.trim(),
      name: name.trim() || undefined,
      variantGroup: variantGroup.trim() || undefined,
      color: color.trim() || undefined,
      flavor: flavor.trim() || undefined,
      size: size.trim() || undefined,
      active,
    };
    startTransition(async () => {
      try {
        const isEdit = variant != null;
        const url = isEdit
          ? `/api/variants/${variant.id}`
          : `/api/products/${productId}/variants`;
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? `Saved ${payload.sku}` : `Added ${payload.sku}`);
        // Warn about SKU edits on existing variants — backend allows
        // it but it's risky once movements/orders reference the SKU.
        if (isEdit && variant && variant.sku !== payload.sku) {
          toast.warning(
            `SKU changed from ${variant.sku} to ${payload.sku}. Past orders and movements still reference the new SKU via variant ID — but external systems may not.`,
          );
        }
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const isEdit = variant != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? 'Edit variant' : 'Add variant'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Variants own the SKU. Attribute fields (color / flavor / size /
            group) are free-text — fill the ones that apply.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <Field>
            <FieldLabel htmlFor="variant-sku">SKU</FieldLabel>
            <Input
              id="variant-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              aria-invalid={!!errors.sku}
              className="font-mono"
            />
            <FieldError errors={[errors.sku ? { message: errors.sku } : undefined]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="variant-name">Name (optional)</FieldLabel>
            <Input
              id="variant-name"
              placeholder="e.g. 100ct bottle"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="variant-group">Group</FieldLabel>
              <Input
                id="variant-group"
                placeholder="e.g. Bottles"
                value={variantGroup}
                onChange={(e) => setVariantGroup(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="variant-size">Size</FieldLabel>
              <Input
                id="variant-size"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="variant-color">Color</FieldLabel>
              <Input
                id="variant-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="variant-flavor">Flavor</FieldLabel>
              <Input
                id="variant-flavor"
                value={flavor}
                onChange={(e) => setFlavor(e.target.value)}
              />
            </Field>
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="variant-active"
              checked={active}
              onCheckedChange={(v) => setActive(v === true)}
            />
            <FieldLabel htmlFor="variant-active">Active</FieldLabel>
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add variant'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
