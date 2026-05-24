import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { RecordCustomerPaymentButton } from '@/components/shared/record-customer-payment-button';

// Pre-invoice payment entry point for CONFIRMED / DISPATCHED orders.
// There's no invoice to apply against yet (it generates on close), so this
// records a customer-level deposit / prepayment — an unapplied credit on
// the customer. When the order closes and the invoice generates, the
// operator applies it via the Available-funds card. Reuses the same
// customer-level "Record payment" flow as the AR tab's top-level button.
export function OrderDepositCard({
  customerId,
  customerName,
  prefill,
}: {
  customerId: string;
  customerName: string;
  // Pre-invoice figure shown at the top of the dialog + used to pre-fill the
  // amount: the quoted order total (CONFIRMED) or shipped balance (DISPATCHED).
  prefill: { label: string; amount: string };
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-sm">Payments &amp; deposits</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Take a prepayment or deposit before the order is invoiced. It posts
            as credit on{' '}
            <span className="font-medium text-foreground">{customerName}</span>{' '}
            and can be applied to the invoice once the order closes.
          </p>
        </div>
        <RecordCustomerPaymentButton
          customerId={customerId}
          customerName={customerName}
          prefill={prefill}
        />
      </CardHeader>
    </Card>
  );
}
