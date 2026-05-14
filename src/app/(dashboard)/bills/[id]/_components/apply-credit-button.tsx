'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApplyCreditDialog } from './apply-credit-dialog';

export function ApplyCreditButton({
  billId,
  billNumber,
  vendorId,
  remainingBalance,
}: {
  billId: string;
  billNumber: string;
  vendorId: string;
  remainingBalance: string;
}) {
  const [open, setOpen] = useState(false);
  const isFullyPaid =
    Number.isFinite(Number(remainingBalance)) &&
    Number(remainingBalance) <= 0;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={isFullyPaid}
        title={isFullyPaid ? 'Bill is fully paid' : undefined}
      >
        <CreditCard />
        Apply credit
      </Button>
      <ApplyCreditDialog
        billId={billId}
        billNumber={billNumber}
        vendorId={vendorId}
        remainingBalance={remainingBalance}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
