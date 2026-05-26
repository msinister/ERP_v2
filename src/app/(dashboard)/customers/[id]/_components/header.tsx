import Link from 'next/link';
import {
  ChevronLeft,
  ExternalLink,
  FileText,
  Pencil,
  Printer,
} from 'lucide-react';
import type { Customer } from '@/generated/tenant';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteCustomerAction } from './delete-action';

// Detail-page header — back link, customer code + name + status,
// edit button, and an action menu housing the destructive delete
// option.

export function CustomerHeader({ customer }: { customer: Customer }) {
  return (
    <div className="space-y-3">
      <Link
        href="/customers"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Customers
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {customer.name}
            </h1>
            {customer.active ? (
              <Badge variant="secondary">Active</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Inactive
              </Badge>
            )}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {customer.code}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  <Printer />
                  Statement
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                render={
                  <Link
                    href={`/print/statements/${customer.id}?type=open`}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <FileText className="size-4" />
                Open balance
                <ExternalLink className="ml-auto size-3 text-muted-foreground" />
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href={`/print/statements/${customer.id}?type=activity`}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <FileText className="size-4" />
                Full activity (YTD)
                <ExternalLink className="ml-auto size-3 text-muted-foreground" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/customers/${customer.id}/edit`} />}
          >
            <Pencil />
            Edit
          </Button>
          <DeleteCustomerAction
            customerId={customer.id}
            customerName={customer.name}
          />
        </div>
      </div>
    </div>
  );
}
