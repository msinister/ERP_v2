import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AddWarehouseButton } from './_components/add-warehouse-button';
import { WarehouseRowActions } from './_components/warehouse-row-actions';

export const revalidate = 0;

export default async function AdminWarehousesPage() {
  await requirePagePermission('admin.edit_settings');

  const [warehouses, glAccounts] = await Promise.all([
    db.warehouse.findMany({
      where: { deletedAt: null },
      include: { inventoryAccount: { select: { id: true, code: true, name: true } } },
      orderBy: { code: 'asc' },
    }),
    // Only Asset accounts are valid inventory accounts for COGS posting.
    db.glAccount.findMany({
      where: { deletedAt: null, active: true, type: 'ASSET' },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              Warehouses
            </h1>
            <p className="text-sm text-muted-foreground">
              Physical locations for inventory. Each warehouse must have an
              Inventory GL Account set before it can be used for sales order
              fulfillment and COGS posting.
            </p>
          </div>
          <AddWarehouseButton glAccounts={glAccounts} />
        </div>
      </div>

      {warehouses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No warehouses yet — add one to get started.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Inventory GL Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {warehouses.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-mono text-xs">{w.code}</TableCell>
                  <TableCell className="font-medium">{w.name}</TableCell>
                  <TableCell>
                    {w.inventoryAccount ? (
                      <span className="text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          {w.inventoryAccount.code}
                        </span>
                        {' — '}
                        {w.inventoryAccount.name}
                      </span>
                    ) : (
                      <span className="text-sm text-destructive">Not set</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {w.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <WarehouseRowActions
                      warehouse={{
                        id: w.id,
                        code: w.code,
                        name: w.name,
                        active: w.active,
                        inventoryAccountId: w.inventoryAccountId,
                      }}
                      glAccounts={glAccounts}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
