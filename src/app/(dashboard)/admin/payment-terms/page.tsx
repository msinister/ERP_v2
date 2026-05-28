import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listPaymentTerms } from '@/server/services/paymentTerms';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AddTermButton } from './_components/add-term-button';
import { TermRowActions } from './_components/term-row-actions';

export const revalidate = 0;

export default async function AdminPaymentTermsPage() {
  await requirePagePermission('admin.edit_settings');

  const terms = await listPaymentTerms(db, { take: 500 });

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
              Payment terms
            </h1>
            <p className="text-sm text-muted-foreground">
              The menu vendors and customers pick from. Code is fixed
              once created — service code references it. Blank net days
              = COD/Prepay.
            </p>
          </div>
          <AddTermButton />
        </div>
      </div>

      {terms.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          No payment terms yet — add one to get started.
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Code</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Net days</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {terms.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.code}</TableCell>
                  <TableCell className="font-medium">{t.label}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.netDays === null ? 'COD / Prepay' : `Net ${t.netDays}`}
                  </TableCell>
                  <TableCell>
                    {t.active ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <TermRowActions
                      term={{
                        id: t.id,
                        code: t.code,
                        label: t.label,
                        netDays: t.netDays,
                        active: t.active,
                      }}
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
