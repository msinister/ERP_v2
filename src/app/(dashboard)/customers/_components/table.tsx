import Link from 'next/link';
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
import { formatCurrency, formatStatusLabel } from '@/lib/format';

export type CustomerRowData = {
  id: string;
  code: string;
  name: string;
  type: string;
  salesRepName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  arBalance: Prisma.Decimal;
  active: boolean;
};

export function CustomersTable({ rows }: { rows: CustomerRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No customers match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead>Code</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Sales rep</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead className="text-right">AR balance</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className="relative cursor-pointer hover:bg-muted/50"
            >
              <TableCell className="font-mono text-xs text-muted-foreground">
                {/* Stretched-link overlay: makes the whole row clickable
                    while preserving middle-click / cmd-click to open in
                    a new tab. position:relative on <tr> is supported in
                    all modern browsers. */}
                <Link
                  href={`/customers/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.name}</span>
                </Link>
                {row.code}
              </TableCell>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatCustomerType(row.type)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.salesRepName}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <ContactCell
                  phone={row.primaryPhone}
                  email={row.primaryEmail}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.arBalance)}
              </TableCell>
              <TableCell>
                {row.active ? (
                  <Badge variant="secondary">Active</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Inactive
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ContactCell({
  phone,
  email,
}: {
  phone: string | null;
  email: string | null;
}) {
  if (!phone && !email) return <span>—</span>;
  return (
    <div className="flex flex-col text-xs leading-tight">
      {email ? <span className="truncate">{email}</span> : null}
      {phone ? <span>{phone}</span> : null}
    </div>
  );
}

// Pretty-print enum values like WHOLESALE_PREFERRED → "Wholesale —
// preferred". Mirrors the human labels in the filters dropdown.
function formatCustomerType(value: string): string {
  if (value === 'RETAIL') return 'Retail';
  if (value.startsWith('WHOLESALE_')) {
    const tail = value.slice('WHOLESALE_'.length);
    return `Wholesale — ${formatStatusLabel(tail).toLowerCase()}`;
  }
  return formatStatusLabel(value);
}
