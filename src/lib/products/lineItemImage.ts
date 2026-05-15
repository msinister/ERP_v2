// =============================================================================
// Helpers for resolving the thumbnail URL for a line-item row.
//
// Every detail-page line query (SO, PO, Receipt, Bill, VC) wants the
// same shape pulled off the variant: the variant's optional override
// `imageUrl`, plus the parent product's primary ProductImage.url.
// `lineItemImageVariantSelect` is the Prisma select fragment to spread
// into each query's `variant.select`. `resolveLineImageUrl` applies the
// preference order:
//
//   variant.imageUrl ?? variant.product.images[0]?.url ?? null
//
// The `images` relation is filtered + take=1 + ordered, so the
// resulting array is either empty or has one row.
// =============================================================================

export const lineItemImageVariantSelect = {
  imageUrl: true,
  product: {
    select: {
      images: {
        where: { isPrimary: true, deletedAt: null },
        select: { url: true },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
    },
  },
} as const;

type VariantImageShape = {
  imageUrl: string | null;
  product: { images: Array<{ url: string }> };
};

export function resolveLineImageUrl(
  variant: VariantImageShape | null | undefined,
): string | null {
  if (!variant) return null;
  return variant.imageUrl ?? variant.product.images[0]?.url ?? null;
}
