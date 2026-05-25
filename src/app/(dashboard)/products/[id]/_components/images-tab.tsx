'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Star, Trash2, Upload, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// =============================================================================
// Product image gallery + per-variant image override.
//
// Gallery (Product level):
//   - Upload a new image — POST multipart/form-data to
//     /api/products/[id]/images. First image auto-primary.
//   - Set primary — PATCH /api/products/[id]/images/[imageId] { setPrimary }.
//   - Delete — DELETE /api/products/[id]/images/[imageId]. Removing the
//     primary auto-promotes the next image (service-side).
//
// Variant override (single image):
//   - POST /api/variants/[id]/image (multipart) to set.
//   - DELETE /api/variants/[id]/image to clear.
// =============================================================================

export type ProductImageRow = {
  id: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
};

export type VariantImageRow = {
  id: string;
  sku: string;
  name: string | null;
  imageUrl: string | null;
};

export function ImagesTab({
  productId,
  productImages,
  variants,
}: {
  productId: string;
  productImages: ProductImageRow[];
  variants: VariantImageRow[];
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">Product images</CardTitle>
            <ProductUploadButton productId={productId} />
          </div>
        </CardHeader>
        <CardContent>
          {productImages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No images yet. Upload one to use as the product&apos;s thumbnail
              on line items.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {productImages.map((img) => (
                <ProductImageCard
                  key={img.id}
                  productId={productId}
                  image={img}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Variant-specific overrides</CardTitle>
        </CardHeader>
        <CardContent>
          {variants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No variants on this product.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                A variant&apos;s image overrides the product&apos;s primary
                image for line-item thumbnails. Leave blank to use the
                product image.
              </p>
              <ul className="divide-y divide-border">
                {variants.map((v) => (
                  <VariantImageRow key={v.id} variant={v} />
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProductImageCard({
  productId,
  image,
}: {
  productId: string;
  image: ProductImageRow;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function setPrimary() {
    if (image.isPrimary || pending) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/products/${productId}/images/${image.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ setPrimary: true }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Set primary failed (${res.status})`);
          return;
        }
        toast.success('Primary image updated');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function remove() {
    if (pending) return;
    if (!confirm('Delete this image?')) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/products/${productId}/images/${image.id}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Delete failed (${res.status})`);
          return;
        }
        toast.success('Image deleted');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      <div className="relative aspect-square overflow-hidden rounded-md bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt={image.altText ?? 'Product image'}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        {image.isPrimary ? (
          <Badge className="absolute left-1.5 top-1.5 gap-1 text-[10px]">
            <Star className="size-3 fill-current" />
            Primary
          </Badge>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-1">
        {image.isPrimary ? (
          <span className="text-xs text-muted-foreground">Primary</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={setPrimary}
            disabled={pending}
            className="gap-1"
          >
            <Star className="size-3.5" />
            Set primary
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete image"
          onClick={remove}
          disabled={pending}
        >
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function ProductUploadButton({ productId }: { productId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Clear the input so the same file can be re-selected after an error.
    e.target.value = '';
    upload(file);
  }

  function upload(file: File) {
    startTransition(async () => {
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/products/${productId}/images`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Upload failed (${res.status})`);
          return;
        }
        toast.success('Image uploaded');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={onFileChange}
      />
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {pending ? 'Uploading…' : 'Upload image'}
      </Button>
    </>
  );
}

function VariantImageRow({ variant }: { variant: VariantImageRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    startTransition(async () => {
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/variants/${variant.id}/image`, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Upload failed (${res.status})`);
          return;
        }
        toast.success(`Updated image for ${variant.sku}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  function clear() {
    if (pending) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/variants/${variant.id}/image`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(body.error ?? `Clear failed (${res.status})`);
          return;
        }
        toast.success(`Cleared image for ${variant.sku}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <li className="flex items-center gap-3 py-2">
      <div className="size-12 shrink-0 overflow-hidden rounded-md bg-muted/30">
        {variant.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={variant.imageUrl}
            alt={`${variant.sku} image`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
            none
          </div>
        )}
      </div>
      <div className="flex-1">
        <div className="font-mono text-xs text-muted-foreground">
          {variant.sku}
        </div>
        {variant.name ? (
          <div className="text-sm">{variant.name}</div>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={onFileChange}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {variant.imageUrl ? 'Replace' : 'Upload'}
      </Button>
      {variant.imageUrl ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Clear image for ${variant.sku}`}
          disabled={pending}
          onClick={clear}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}
