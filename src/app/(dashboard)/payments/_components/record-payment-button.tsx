'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  RecordPaymentDialog,
  type CustomerOption,
} from './record-payment-dialog';

export function RecordPaymentButton({
  customers,
}: {
  customers: CustomerOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Record payment
      </Button>
      <RecordPaymentDialog
        customers={customers}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
