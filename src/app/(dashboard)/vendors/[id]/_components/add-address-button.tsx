'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AddressFormDialog } from './address-form-dialog';

export function AddAddressButton({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        Add address
      </Button>
      <AddressFormDialog
        vendorId={vendorId}
        address={null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
