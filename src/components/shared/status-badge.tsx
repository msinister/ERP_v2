import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatStatusLabel } from '@/lib/format';

// =============================================================================
// Shared status badge. One component for every entity-status chip across
// list pages, detail headers, and mobile cards. Colors mirror the pilot's
// product brief:
//
//   grey      light-neutral for DRAFT / PENDING (work-in-progress, no AR/AP
//             impact yet)
//   green     confirmed / approved (the entity has effect on the books)
//   yellow    in-flight intermediate state (DISPATCHED, PARTIALLY_RECEIVED,
//             IN_TRANSIT, RECEIVED, PARTIAL payment)
//   blue      terminal-positive (CLOSED, CREDITED, COMPLETED, PAID)
//   red       blocking / failure (UNPAID, REJECTED)
//   outline   terminal-unhappy (CANCELLED, VOIDED) — same visual weight as
//             grey but the open border signals the entity is "closed off"
//
// Add new entity coverage by extending STATUS_TONES + (optional) LABEL_
// OVERRIDES. Statuses with no entry fall through to `outline` so a
// missing mapping is visually obvious in dev without crashing.
// =============================================================================

export type StatusEntityType =
  | 'SalesOrder'
  | 'PurchaseOrder'
  | 'Bill'
  | 'BillPaymentStatus'
  | 'CreditMemo'
  | 'Payment'
  | 'Rma'
  | 'VendorCredit'
  | 'WorkOrder';

export type StatusTone =
  | 'grey'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'red'
  | 'outline';

// Tailwind class strings keyed by tone. Hex equivalents in the comments
// match the spec; the dark-mode variants soften the saturated tones so
// chips don't glow against the dark surface.
const TONE_CLASSES: Record<StatusTone, string> = {
  grey:
    'bg-gray-100 text-gray-900 border-transparent ' +
    'dark:bg-gray-800 dark:text-gray-100',
  green:
    'bg-green-600 text-white border-transparent ' +
    'dark:bg-green-500 dark:text-white',
  yellow:
    'bg-yellow-500 text-gray-900 border-transparent ' +
    'dark:bg-yellow-400 dark:text-gray-900',
  blue:
    'bg-blue-600 text-white border-transparent ' +
    'dark:bg-blue-500 dark:text-white',
  red:
    'bg-red-600 text-white border-transparent ' +
    'dark:bg-red-500 dark:text-white',
  outline: 'bg-background text-muted-foreground border-border',
};

const STATUS_TONES: Record<StatusEntityType, Record<string, StatusTone>> = {
  SalesOrder: {
    DRAFT: 'grey',
    CONFIRMED: 'green',
    DISPATCHED: 'yellow',
    CLOSED: 'blue',
    CANCELLED: 'outline',
  },
  PurchaseOrder: {
    DRAFT: 'grey',
    CONFIRMED: 'green',
    PARTIALLY_RECEIVED: 'yellow',
    CLOSED: 'blue',
    CANCELLED: 'outline',
  },
  Bill: {
    DRAFT: 'grey',
    CONFIRMED: 'green',
    CANCELLED: 'outline',
  },
  // Bill-level payment status (separate from BillStatus). Enum value
  // PARTIAL maps to the user-facing "PARTIALLY_PAID" shape.
  BillPaymentStatus: {
    UNPAID: 'red',
    PARTIAL: 'yellow',
    PAID: 'blue',
  },
  CreditMemo: {
    DRAFT: 'grey',
    CONFIRMED: 'green',
    VOIDED: 'outline',
  },
  // Customer payment lifecycle. RECORDED is live (money received);
  // REVERSED is unwound (terminal-unhappy, like a void).
  Payment: {
    RECORDED: 'green',
    REVERSED: 'outline',
  },
  Rma: {
    PENDING: 'grey',
    APPROVED: 'green',
    IN_TRANSIT: 'yellow',
    RECEIVED: 'yellow',
    INSPECTED: 'green',
    CREDITED: 'blue',
    REJECTED: 'red',
  },
  VendorCredit: {
    DRAFT: 'grey',
    CONFIRMED: 'green',
    CANCELLED: 'outline',
  },
  WorkOrder: {
    DRAFT: 'grey',
    IN_PROGRESS: 'yellow',
    COMPLETED: 'blue',
    CANCELLED: 'outline',
  },
};

// Friendly label overrides per-entity. RMAs read "Pending Review" /
// "In Transit"; everything else falls through to formatStatusLabel
// (which capitalizes the token and handles documented exceptions
// like PARTIALLY_RECEIVED → "Partially received").
const LABEL_OVERRIDES: Partial<
  Record<StatusEntityType, Record<string, string>>
> = {
  Rma: {
    PENDING: 'Pending Review',
    APPROVED: 'Approved',
    IN_TRANSIT: 'In Transit',
    RECEIVED: 'Received',
    INSPECTED: 'Inspected',
    CREDITED: 'Credited',
    REJECTED: 'Rejected',
  },
  BillPaymentStatus: {
    UNPAID: 'Unpaid',
    PARTIAL: 'Partially paid',
    PAID: 'Paid',
  },
};

export function getStatusTone(
  entityType: StatusEntityType,
  status: string,
): StatusTone {
  return STATUS_TONES[entityType][status] ?? 'outline';
}

export function getStatusLabel(
  entityType: StatusEntityType,
  status: string,
): string {
  return LABEL_OVERRIDES[entityType]?.[status] ?? formatStatusLabel(status);
}

export function StatusBadge({
  entityType,
  status,
  className,
}: {
  entityType: StatusEntityType;
  status: string;
  className?: string;
}) {
  const tone = getStatusTone(entityType, status);
  const label = getStatusLabel(entityType, status);
  return <Badge className={cn(TONE_CLASSES[tone], className)}>{label}</Badge>;
}
