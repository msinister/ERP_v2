import { db } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { agingForVendor } from '@/server/services/ap';
import { formatCurrency } from '@/lib/format';
import { TabShell, TabEmpty } from './tab-shell';

const BUCKET_LABELS: Record<string, string> = {
  current: 'Current',
  b1to30: '1–30',
  b31to60: '31–60',
  b61to90: '61–90',
  b91plus: '91+',
};

export async function ApTab({ vendorId }: { vendorId: string }) {
  // agingForVendor returns buckets + per-bill rows + total +
  // unappliedCreditBalance in one call. AP balance + unappliedCredit
  // are never netted into a single signed number per service contract.
  const aging = await agingForVendor(db, vendorId);

  return (
    <TabShell>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Aging summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-2">
            {(['current', 'b1to30', 'b31to60', 'b61to90', 'b91plus'] as const).map(
              (key) => {
                const isOverdue = key === 'b91plus';
                const value = aging.buckets[key];
                return (
                  <div
                    key={key}
                    className={
                      'rounded-md border border-border p-3 ' +
                      (isOverdue && value.gt(0)
                        ? 'border-destructive/30 bg-destructive/5'
                        : '')
                    }
                  >
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {BUCKET_LABELS[key]}
                    </div>
                    <div
                      className={
                        'mt-0.5 text-sm tabular-nums ' +
                        (isOverdue && value.gt(0)
                          ? 'text-destructive'
                          : 'text-foreground')
                      }
                    >
                      {formatCurrency(value)}
                    </div>
                  </div>
                );
              },
            )}
          </div>
          <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-border pt-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Total open AP</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatCurrency(aging.total)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">
                Unapplied vendor credit
              </div>
              <div className="text-lg font-semibold tabular-nums">
                {formatCurrency(aging.unappliedCreditBalance)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Open bills
        </h2>
        {aging.bills.length === 0 ? (
          <TabEmpty message="No open bills." />
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>Bill #</TableHead>
                  <TableHead>Vendor ref</TableHead>
                  <TableHead>Bill date</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Credited</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Days past due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aging.bills.map((row) => {
                  const overdue = row.daysPastDue > 0;
                  return (
                    <TableRow key={row.billId}>
                      <TableCell className="font-mono text-xs">
                        {row.number}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.vendorReference ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.billDate.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.dueDate.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(row.total)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(row.amountPaid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(row.amountCredited)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatCurrency(row.balance)}
                      </TableCell>
                      <TableCell
                        className={
                          'text-right tabular-nums ' +
                          (overdue ? 'text-destructive' : 'text-muted-foreground')
                        }
                      >
                        {row.daysPastDue}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </TabShell>
  );
}
