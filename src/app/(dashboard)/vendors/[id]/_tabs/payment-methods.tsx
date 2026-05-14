import { db } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listVendorPaymentMethods } from '@/server/services/vendorPaymentMethods';
import { TabShell, TabEmpty } from './tab-shell';
import { AddPaymentMethodButton } from '../_components/add-payment-method-button';
import { PaymentMethodRowActions } from '../_components/payment-method-row-actions';

export async function PaymentMethodsTab({ vendorId }: { vendorId: string }) {
  // List returns metadata ONLY — encryptedPayload and IV are stripped
  // at the service boundary. Cleartext goes through the audited reveal
  // dialog which fetches the dedicated /cleartext endpoint.
  const methods = await listVendorPaymentMethods(db, vendorId);

  if (methods.length === 0) {
    return (
      <TabShell>
        <TabEmpty
          message="No payment methods on file."
          action={<AddPaymentMethodButton vendorId={vendorId} />}
        />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <div className="flex justify-end">
        <AddPaymentMethodButton vendorId={vendorId} />
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Kind</TableHead>
              <TableHead>Display hint</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="w-28">Preferred</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {methods.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <Badge variant="outline" className="text-muted-foreground">
                    {formatKind(m.kind)}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {m.displayHint}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {m.label ?? '—'}
                </TableCell>
                <TableCell>
                  {m.isPreferred ? (
                    <Badge variant="secondary">Preferred</Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  {m.active ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Inactive
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <PaymentMethodRowActions
                    vendorId={vendorId}
                    paymentMethod={{
                      id: m.id,
                      // displayHint is nullable in the schema but the
                      // service always derives a non-null string on
                      // create. Fall back defensively for legacy rows
                      // that pre-date the derivation.
                      displayHint: m.displayHint ?? formatKind(m.kind),
                      isPreferred: m.isPreferred,
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}

function formatKind(value: string): string {
  if (value === 'ACH') return 'ACH';
  if (value === 'WIRE') return 'Wire';
  if (value === 'CHECK') return 'Check';
  if (value === 'CREDIT_CARD') return 'Credit card';
  return value;
}
