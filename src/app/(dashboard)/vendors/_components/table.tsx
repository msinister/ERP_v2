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
import { formatCurrency } from '@/lib/format';

export type VendorRowData = {
  id: string;
  code: string;
  name: string;
  type: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  apBalance: Prisma.Decimal;
  active: boolean;
};

export function VendorsTable({ rows }: { rows: VendorRowData[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
        No vendors match these filters.
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
            <TableHead>Contact</TableHead>
            <TableHead className="text-right">AP balance</TableHead>
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
                {/* Stretched-link overlay — see customer table for the
                    pattern. Preserves middle-click / cmd-click. */}
                <Link
                  href={`/vendors/${row.id}`}
                  className="absolute inset-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="sr-only">View {row.name}</span>
                </Link>
                {row.code}
              </TableCell>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatVendorType(row.type)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <ContactCell
                  name={row.primaryContactName}
                  email={row.primaryContactEmail}
                  phone={row.primaryContactPhone}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(row.apBalance)}
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
  name,
  email,
  phone,
}: {
  name: string | null;
  email: string | null;
  phone: string | null;
}) {
  if (!name && !email && !phone) return <span>—</span>;
  return (
    <div className="flex flex-col text-xs leading-tight">
      {name ? <span className="text-foreground">{name}</span> : null}
      {email ? <span className="truncate">{email}</span> : null}
      {phone ? <span>{phone}</span> : null}
    </div>
  );
}

function formatVendorType(value: string): string {
  if (value === 'STOCK') return 'Stock';
  if (value === 'DROP_SHIP') return 'Drop-ship';
  if (value === 'SERVICE') return 'Service';
  return value;
}
