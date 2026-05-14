'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaymentMethodFormDialog } from './payment-method-form-dialog';

export function AddPaymentMethodButton({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        Add payment method
      </Button>
      <PaymentMethodFormDialog
        vendorId={vendorId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
