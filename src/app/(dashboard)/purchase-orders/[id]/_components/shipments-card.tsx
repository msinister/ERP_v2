'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, MoreVertical, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { isNonNegativeDecimalInput, normalizeDecimalForSubmit } from '@/lib/decimal-input';

export type ShipmentRow = {
  id: string;
  shipmentStatus: string;
  trackingNumber: string | null;
  carrierName: string | null;
  trackingUrl: string | null;
  cartonCount: number | null;
  totalWeight: string | null;
  weightUnit: string;
  estimatedArrival: Date | null;
  notes: string | null;
};

const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'PAID', label: 'Paid' },
  { value: 'IN_PRODUCTION', label: 'In Production' },
  { value: 'IN_TRANSIT', label: 'In Transit' },
  { value: 'DELIVERED', label: 'Delivered' },
];

function statusLabel(value: string): string {
  return STATUSES.find((s) => s.value === value)?.label ?? value;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ path?: Array<string | number>; message?: string }>;
    };
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function ShipmentsCard({
  purchaseOrderId,
  shipments,
}: {
  purchaseOrderId: string;
  shipments: ShipmentRow[];
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ShipmentRow | null>(null);
  const [deleting, setDeleting] = useState<ShipmentRow | null>(null);

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(row: ShipmentRow) {
    setEditing(row);
    setFormOpen(true);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Shipments</CardTitle>
        <Button size="sm" onClick={openAdd}>
          <Plus />
          Add shipment
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {shipments.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            No shipments tracked yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-6">Status</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead>Tracking #</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="pr-6 w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-6">
                    <StatusBadge entityType="PoShipment" status={s.shipmentStatus} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.carrierName ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.trackingNumber ? (
                      s.trackingUrl ? (
                        <a
                          href={s.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                        >
                          {s.trackingNumber}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        s.trackingNumber
                      )
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.cartonCount ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.totalWeight ? `${s.totalWeight} ${s.weightUnit}` : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.estimatedArrival ? formatDate(s.estimatedArrival) : '—'}
                  </TableCell>
                  <TableCell className="max-w-[20ch] truncate text-muted-foreground" title={s.notes ?? undefined}>
                    {s.notes ?? '—'}
                  </TableCell>
                  <TableCell className="pr-6">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for shipment`}
                          />
                        }
                      >
                        <MoreVertical />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.preventDefault();
                            openEdit(s);
                          }}
                        >
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.preventDefault();
                            setDeleting(s);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <ShipmentFormDialog
        purchaseOrderId={purchaseOrderId}
        editing={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
      <DeleteShipmentDialog
        purchaseOrderId={purchaseOrderId}
        shipment={deleting}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function ShipmentFormDialog({
  purchaseOrderId,
  editing,
  open,
  onOpenChange,
}: {
  purchaseOrderId: string;
  editing: ShipmentRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState('IN_PRODUCTION');
  const [carrierName, setCarrierName] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [cartonCount, setCartonCount] = useState('');
  const [totalWeight, setTotalWeight] = useState('');
  const [weightUnit, setWeightUnit] = useState('lbs');
  const [estimatedArrival, setEstimatedArrival] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed every time the dialog opens — prefill from `editing` (edit
  // mode) or reset to defaults (add mode).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setStatus(editing?.shipmentStatus ?? 'IN_PRODUCTION');
    setCarrierName(editing?.carrierName ?? '');
    setTrackingNumber(editing?.trackingNumber ?? '');
    setTrackingUrl(editing?.trackingUrl ?? '');
    setCartonCount(editing?.cartonCount != null ? String(editing.cartonCount) : '');
    setTotalWeight(editing?.totalWeight ?? '');
    setWeightUnit(editing?.weightUnit ?? 'lbs');
    setEstimatedArrival(
      editing?.estimatedArrival
        ? editing.estimatedArrival.toISOString().slice(0, 10)
        : '',
    );
    setNotes(editing?.notes ?? '');
  }, [open, editing]);

  function submit() {
    setError(null);
    if (cartonCount && !/^\d+$/.test(cartonCount.trim())) {
      setError('Cartons must be a whole number');
      return;
    }
    if (totalWeight && !isNonNegativeDecimalInput(totalWeight)) {
      setError('Weight must be a non-negative number');
      return;
    }
    // null clears a field on edit; undefined leaves it unset on add. We
    // send null so a cleared field is explicit either way.
    const payload = {
      shipmentStatus: status,
      carrierName: carrierName.trim() || null,
      trackingNumber: trackingNumber.trim() || null,
      trackingUrl: trackingUrl.trim() || null,
      cartonCount: cartonCount.trim() ? Number(cartonCount.trim()) : null,
      totalWeight: totalWeight.trim() ? normalizeDecimalForSubmit(totalWeight) : null,
      weightUnit: weightUnit.trim() || 'lbs',
      estimatedArrival: estimatedArrival || null,
      notes: notes.trim() || null,
    };
    const url = editing
      ? `/api/purchase-orders/${purchaseOrderId}/shipments/${editing.id}`
      : `/api/purchase-orders/${purchaseOrderId}/shipments`;
    const method = editing ? 'PATCH' : 'POST';
    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(editing ? 'Shipment updated' : 'Shipment added');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {editing ? 'Edit shipment' : 'Add shipment'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Logistics tracking only — no inventory or GL effect. Receiving
            stays the receipt flow.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="ship-status">Status</FieldLabel>
              <Select value={status} onValueChange={(v) => setStatus(v ?? 'IN_PRODUCTION')}>
                <SelectTrigger id="ship-status" className="w-full">
                  <SelectValue>{(v) => statusLabel((v as string) ?? status)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="ship-carrier">Carrier</FieldLabel>
              <Input
                id="ship-carrier"
                placeholder="optional"
                value={carrierName}
                onChange={(e) => setCarrierName(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="ship-tracking">Tracking #</FieldLabel>
            <Input
              id="ship-tracking"
              placeholder="optional"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ship-url">Tracking URL</FieldLabel>
            <Input
              id="ship-url"
              placeholder="https://… (optional)"
              value={trackingUrl}
              onChange={(e) => setTrackingUrl(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="ship-cartons">Cartons</FieldLabel>
              <Input
                id="ship-cartons"
                inputMode="numeric"
                placeholder="optional"
                value={cartonCount}
                onChange={(e) => setCartonCount(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ship-weight">Weight</FieldLabel>
              <Input
                id="ship-weight"
                inputMode="decimal"
                placeholder="optional"
                value={totalWeight}
                onChange={(e) => setTotalWeight(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ship-unit">Unit</FieldLabel>
              <Input
                id="ship-unit"
                value={weightUnit}
                onChange={(e) => setWeightUnit(e.target.value)}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="ship-eta">Estimated arrival</FieldLabel>
            <Input
              id="ship-eta"
              type="date"
              value={estimatedArrival}
              onChange={(e) => setEstimatedArrival(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ship-notes">Notes</FieldLabel>
            <Textarea
              id="ship-notes"
              rows={2}
              placeholder="optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Add shipment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteShipmentDialog({
  purchaseOrderId,
  shipment,
  onClose,
}: {
  purchaseOrderId: string;
  shipment: ShipmentRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!shipment) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/purchase-orders/${purchaseOrderId}/shipments/${shipment.id}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success('Shipment removed');
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={shipment != null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Truck className="size-4" />
            Remove this shipment?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This hides the shipment from the PO. It has no inventory or GL
            effect.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? 'Removing…' : 'Remove shipment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
