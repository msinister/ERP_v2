import type { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';

export type VcLineRow = {
  id: string;
  description: string;
  amount: Prisma.Decimal;
  notes: string | null;
};

export function VendorCreditLinesTable({ lines }: { lines: VcLineRow[] }) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No lines on this credit.
      </div>
    );
  }

  return (
    <>
      {/* Mobile card stack. */}
      <div className="space-y-3 md:hidden">
        {lines.map((l) => (
          <div
            key={l.id}
            className="rounded-lg border border-border bg-card p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium">{l.description}</div>
              <div className="shrink-0 tabular-nums font-medium">
                {formatCurrency(l.amount)}
              </div>
            </div>
            {l.notes ? (
              <div className="mt-1 text-xs italic text-muted-foreground">
                “{l.notes}”
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Desktop table. */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table containerClassName="max-h-[60vh] overflow-y-auto">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <div className="font-medium">{l.description}</div>
                  {l.notes ? (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      “{l.notes}”
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(l.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
