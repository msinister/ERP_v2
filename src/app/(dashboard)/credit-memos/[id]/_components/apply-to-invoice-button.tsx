'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApplyToInvoiceDialog } from './apply-to-invoice-dialog';

export function ApplyToInvoiceButton({
  creditMemoId,
  creditMemoNumber,
  customerId,
  available,
}: {
  creditMemoId: string;
  creditMemoNumber: string;
  customerId: string;
  available: string;
}) {
  const [open, setOpen] = useState(false);
  const fullyApplied =
    Number.isFinite(Number(available)) && Number(available) <= 0;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={fullyApplied}
        title={fullyApplied ? 'Credit is fully applied' : undefined}
      >
        <Plus />
        Apply to invoice
      </Button>
      <ApplyToInvoiceDialog
        creditMemoId={creditMemoId}
        creditMemoNumber={creditMemoNumber}
        customerId={customerId}
        available={available}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
