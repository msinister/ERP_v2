import Link from 'next/link';
import { ChevronLeft, MoreVertical, Pencil } from 'lucide-react';
import type { Vendor } from '@/generated/tenant';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeleteVendorAction } from './delete-action';

// Detail-page header — back link, vendor code + name + type/status
// badges, edit button, and an action menu housing the destructive
// delete option.

export function VendorHeader({ vendor }: { vendor: Vendor }) {
  return (
    <div className="space-y-3">
      <Link
        href="/vendors"
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Vendors
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {vendor.name}
            </h1>
            <Badge variant="outline" className="text-muted-foreground">
              {formatVendorType(vendor.type)}
            </Badge>
            {vendor.active ? (
              <Badge variant="secondary">Active</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Inactive
              </Badge>
            )}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {vendor.code}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/vendors/${vendor.id}/edit`} />}
          >
            <Pencil />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="More actions"
                />
              }
            >
              <MoreVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DeleteVendorAction
                vendorId={vendor.id}
                vendorName={vendor.name}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function formatVendorType(value: string): string {
  if (value === 'STOCK') return 'Stock';
  if (value === 'DROP_SHIP') return 'Drop-ship';
  if (value === 'SERVICE') return 'Service';
  return value;
}
