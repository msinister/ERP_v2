'use client';

import { useState } from 'react';
import { DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  RecordPaymentDialog,
  type CashAccountOption,
} from './record-payment-dialog';

export function RecordPaymentButton({
  billId,
  billNumber,
  remainingBalance,
  cashAccounts,
}: {
  billId: string;
  billNumber: string;
  remainingBalance: string;
  cashAccounts: CashAccountOption[];
}) {
  const [open, setOpen] = useState(false);
  const isFullyPaid =
    Number.isFinite(Number(remainingBalance)) &&
    Number(remainingBalance) <= 0;
  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={isFullyPaid}
        title={isFullyPaid ? 'Bill is fully paid' : undefined}
      >
        <DollarSign />
        Record payment
      </Button>
      <RecordPaymentDialog
        billId={billId}
        billNumber={billNumber}
        remainingBalance={remainingBalance}
        cashAccounts={cashAccounts}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
