'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ProductFormDialog,
  type VariantOption,
} from './product-form-dialog';

export function AddProductButton({
  vendorId,
  variants,
  existingVariantIds,
  disabledReason,
}: {
  vendorId: string;
  variants: VariantOption[];
  existingVariantIds: ReadonlySet<string>;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={!!disabledReason}
        title={disabledReason}
      >
        <Plus />
        Add catalog row
      </Button>
      <ProductFormDialog
        vendorId={vendorId}
        variants={variants}
        existingVariantIds={existingVariantIds}
        product={null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
