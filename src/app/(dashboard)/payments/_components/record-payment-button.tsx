'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  SalesRepOption,
  PaymentTermOption,
} from '@/components/shared/customer-picker';
import {
  RecordPaymentDialog,
  type CustomerOption,
} from './record-payment-dialog';

export function RecordPaymentButton({
  customers,
  salesReps,
  paymentTerms,
  defaultSalesRepId,
}: {
  customers: CustomerOption[];
  salesReps: SalesRepOption[];
  paymentTerms: PaymentTermOption[];
  defaultSalesRepId: string | null;
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
        salesReps={salesReps}
        paymentTerms={paymentTerms}
        defaultSalesRepId={defaultSalesRepId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
