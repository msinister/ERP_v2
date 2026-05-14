'use client';

import Link from 'next/link';
import { ExternalLink, FileText, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Print + view buttons for the SO detail. Each item opens the doc in
// a new tab so the operator keeps their SO context while the print
// dialog runs in the new tab. Slice Doc-A wires Print SO + View
// Invoice; Doc-B layers in Pick Sheet + Packing Slip.

export type SalesOrderDocumentsMenuProps = {
  salesOrderId: string;
  status: string;
  invoice: { id: string } | null;
};

export function DocumentsMenu({
  salesOrderId,
  status,
  invoice,
}: SalesOrderDocumentsMenuProps) {
  // Pick Sheet is meaningful once the SO is locked for reservation
  // (CONFIRMED). DISPATCHED still wants it for backorder picks.
  const canPick = status === 'CONFIRMED' || status === 'DISPATCHED';
  // Packing Slip lives with the physical shipment — DISPATCHED is
  // when it's printed; CLOSED operators may need a reprint.
  const canPack = status === 'DISPATCHED' || status === 'CLOSED';
  const hasInvoice = invoice != null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <Printer />
            Documents
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          render={
            <Link
              href={`/documents/sales-order/${salesOrderId}`}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <FileText className="size-4" />
          Print SO
          <ExternalLink className="ml-auto size-3 text-muted-foreground" />
        </DropdownMenuItem>
        {canPick ? (
          <DropdownMenuItem
            render={
              <Link
                href={`/documents/pick-sheet/${salesOrderId}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <FileText className="size-4" />
            Print pick sheet
            <ExternalLink className="ml-auto size-3 text-muted-foreground" />
          </DropdownMenuItem>
        ) : null}
        {canPack ? (
          <DropdownMenuItem
            render={
              <Link
                href={`/documents/packing-slip/${salesOrderId}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <FileText className="size-4" />
            Print packing slip
            <ExternalLink className="ml-auto size-3 text-muted-foreground" />
          </DropdownMenuItem>
        ) : null}
        {hasInvoice ? (
          <DropdownMenuItem
            render={
              <Link
                href={`/documents/invoice/${invoice.id}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <FileText className="size-4" />
            View invoice
            <ExternalLink className="ml-auto size-3 text-muted-foreground" />
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
