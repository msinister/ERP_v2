'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApplyToBillDialog } from './apply-to-bill-dialog';

export function ApplyToBillButton({
  vendorCreditId,
  vendorCreditNumber,
  vendorId,
  available,
}: {
  vendorCreditId: string;
  vendorCreditNumber: string;
  vendorId: string;
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
        Apply to bill
      </Button>
      <ApplyToBillDialog
        vendorCreditId={vendorCreditId}
        vendorCreditNumber={vendorCreditNumber}
        vendorId={vendorId}
        available={available}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
