'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddressFormDialog, type AddressRow } from './address-form-dialog';
import { TabShell, TabEmpty } from '../_tabs/tab-shell';

type Props = {
  customerId: string;
  addresses: AddressRow[];
};

export function AddressesClient({ customerId, addresses }: Props) {
  const billing = addresses.filter((a) => a.kind === 'BILLING');
  const shipping = addresses.filter((a) => a.kind === 'SHIPPING');

  const [formOpen, setFormOpen] = useState(false);
  const [editAddress, setEditAddress] = useState<AddressRow | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openAdd() {
    setEditAddress(undefined);
    setFormOpen(true);
  }

  function openEdit(address: AddressRow) {
    setEditAddress(address);
    setFormOpen(true);
  }

  const hasBillingAddress = billing.length > 0;

  return (
    <TabShell>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {addresses.length === 0 ? 'No addresses on file.' : null}
        </span>
        <Button size="sm" onClick={openAdd}>
          <Plus className="size-3.5" />
          Add address
        </Button>
      </div>

      {billing.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Billing</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {billing.map((a) => (
              <AddressCard
                key={a.id}
                address={a}
                onEdit={() => openEdit(a)}
                onDelete={() => setDeleteId(a.id)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {shipping.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Shipping</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {shipping.map((a) => (
              <AddressCard
                key={a.id}
                address={a}
                onEdit={() => openEdit(a)}
                onDelete={() => setDeleteId(a.id)}
                customerId={customerId}
              />
            ))}
          </div>
        </section>
      ) : null}

      {addresses.length === 0 ? (
        <TabEmpty message="No addresses on file. Add a billing or shipping address above." />
      ) : null}

      {/* Dialogs rendered outside dropdowns to avoid unmount-on-close flash */}
      <AddressFormDialog
        customerId={customerId}
        address={editAddress}
        open={formOpen}
        onOpenChange={setFormOpen}
        hasBillingAddress={hasBillingAddress}
      />

      <DeleteAddressDialog
        customerId={customerId}
        addressId={deleteId}
        open={deleteId !== null}
        onOpenChange={(o) => { if (!o) setDeleteId(null); }}
      />
    </TabShell>
  );
}

// ---------------------------------------------------------------------------
// Per-address card
// ---------------------------------------------------------------------------

function AddressCard({
  address,
  onEdit,
  onDelete,
  customerId,
}: {
  address: AddressRow;
  onEdit: () => void;
  onDelete: () => void;
  customerId?: string; // only for shipping (set-default)
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>{address.label ?? 'Address'}</span>
          <div className="flex items-center gap-1.5">
            {address.isDefault ? (
              <Badge variant="secondary">Default</Badge>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Address actions"
                  />
                }
              >
                <MoreVertical className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="size-4" />
                  Edit
                </DropdownMenuItem>
                {customerId && !address.isDefault ? (
                  <SetDefaultMenuItem customerId={customerId} addressId={address.id} />
                ) : null}
                <DropdownMenuItem onClick={onDelete} variant="destructive">
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {address.attention ? (
          <div className="text-muted-foreground">Attn: {address.attention}</div>
        ) : null}
        <div>{address.line1}</div>
        {address.line2 ? <div>{address.line2}</div> : null}
        <div>
          {address.city}, {address.region} {address.postalCode}
        </div>
        <div className="text-muted-foreground">{address.country}</div>
        {address.phone ? (
          <div className="pt-1 text-muted-foreground">{address.phone}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Set as default — inline menu item with its own pending state
// ---------------------------------------------------------------------------

function SetDefaultMenuItem({
  customerId,
  addressId,
}: {
  customerId: string;
  addressId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function setDefault() {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/customers/${customerId}/addresses/${addressId}/set-default`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? 'Failed to set default');
          return;
        }
        toast.success('Default ship-to updated');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <DropdownMenuItem onClick={setDefault} disabled={pending}>
      <Star className="size-4" />
      {pending ? 'Setting…' : 'Set as default ship-to'}
    </DropdownMenuItem>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog — rendered as sibling outside the dropdown
// ---------------------------------------------------------------------------

function DeleteAddressDialog({
  customerId,
  addressId,
  open,
  onOpenChange,
}: {
  customerId: string;
  addressId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!addressId) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/customers/${customerId}/addresses/${addressId}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? 'Delete failed');
          return;
        }
        toast.success('Address deleted');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this address?</AlertDialogTitle>
          <AlertDialogDescription>
            The address will be removed from the customer record. This cannot
            be undone from the UI (the record is retained in the audit log).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
