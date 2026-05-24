'use client';

import { useState, type ReactNode } from 'react';
import { DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  RecordCustomerPaymentDialog,
  type PaymentPrefill,
  type TargetInvoice,
} from './record-customer-payment-dialog';

// Trigger + dialog state wrapper. Two shapes:
//
//   - Invoice-bound: pass `targetInvoice`. The button auto-disables
//     when the invoice is fully paid (balance ≤ 0).
//   - Customer-level / unapplied: omit `targetInvoice`. Used for the
//     "Record payment" entry point on the Customer AR tab when the
//     operator hasn't picked an invoice yet.
//
// `children` overrides the default label so call-sites can render a
// tighter inline button (e.g. on a per-row AR table cell).

export function RecordCustomerPaymentButton({
  customerId,
  customerName,
  targetInvoice,
  prefill,
  size = 'sm',
  variant = 'default',
  children,
}: {
  customerId: string;
  customerName: string;
  targetInvoice?: TargetInvoice;
  // Pre-invoice deposit context (label + amount) for the customer-level case.
  prefill?: PaymentPrefill;
  size?: 'sm' | 'default' | 'icon-sm';
  variant?: 'default' | 'outline' | 'ghost';
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isFullyPaid =
    targetInvoice != null &&
    Number.isFinite(Number(targetInvoice.remainingBalance)) &&
    Number(targetInvoice.remainingBalance) <= 0;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        onClick={() => setOpen(true)}
        disabled={isFullyPaid}
        title={isFullyPaid ? 'Invoice is fully paid' : undefined}
      >
        <DollarSign />
        {children ?? 'Record payment'}
      </Button>
      <RecordCustomerPaymentDialog
        customerId={customerId}
        customerName={customerName}
        targetInvoice={targetInvoice ?? null}
        prefill={prefill ?? null}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
