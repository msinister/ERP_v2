import type { Prisma } from '@/generated/tenant';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { TabEmpty, TabShell } from './tab-shell';

export type MovementRow = {
  id: string;
  createdAt: Date;
  type: string;
  variantSku: string;
  warehouseCode: string;
  qty: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  reference: string | null;
  notes: string | null;
  negativeAllocation: boolean;
};

export function MovementsTab({ rows }: { rows: MovementRow[] }) {
  if (rows.length === 0) {
    return (
      <TabShell>
        <TabEmpty message="No inventory movements recorded yet." />
      </TabShell>
    );
  }

  return (
    <TabShell>
      <p className="text-sm text-muted-foreground">
        Most recent 50 movements across all variants of this product.
        Receives add to inventory; consumes deplete it; adjusts can go
        either way.
      </p>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>When</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead>Reference</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(r.createdAt)}
                </TableCell>
                <TableCell>
                  <TypeBadge type={r.type} negativeAllocation={r.negativeAllocation} />
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {r.variantSku}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {r.warehouseCode}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${
                    r.qty.lessThan(0) ? 'text-destructive' : ''
                  }`}
                >
                  {formatSignedQty(r.qty)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.unitCost != null ? formatCurrency(r.unitCost) : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.reference ?? '—'}
                  {r.notes ? (
                    <div className="italic">{r.notes}</div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabShell>
  );
}

function TypeBadge({
  type,
  negativeAllocation,
}: {
  type: string;
  negativeAllocation: boolean;
}) {
  const label = formatType(type);
  // Tone signals direction at a glance.
  switch (type) {
    case 'RECEIVE':
      return <Badge variant="secondary">{label}</Badge>;
    case 'CONSUME':
      return (
        <Badge variant={negativeAllocation ? 'destructive' : 'outline'}>
          {label}
          {negativeAllocation ? ' (neg)' : ''}
        </Badge>
      );
    case 'ADJUST':
      return <Badge variant="outline">{label}</Badge>;
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return <Badge variant="outline">{label}</Badge>;
    case 'RECEIVE_REVERSE':
      return <Badge variant="destructive">{label}</Badge>;
    case 'RMA_RETURN':
      return <Badge variant="secondary">{label}</Badge>;
    default:
      return <Badge variant="outline">{label}</Badge>;
  }
}

function formatType(t: string): string {
  switch (t) {
    case 'RECEIVE':
      return 'Receive';
    case 'CONSUME':
      return 'Consume';
    case 'ADJUST':
      return 'Adjust';
    case 'TRANSFER_OUT':
      return 'Transfer out';
    case 'TRANSFER_IN':
      return 'Transfer in';
    case 'RECEIVE_REVERSE':
      return 'Reverse';
    case 'RMA_RETURN':
      return 'RMA return';
    default:
      return t;
  }
}

function formatSignedQty(qty: Prisma.Decimal): string {
  const s = qty.toString();
  const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  if (qty.greaterThan(0) && !trimmed.startsWith('+')) return `+${trimmed}`;
  return trimmed;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
