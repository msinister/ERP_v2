import { AuditAction } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { formatCurrency } from '@/lib/format';

// =============================================================================
// Customer activity timeline — merges two sources into a single, sorted feed.
//
// SOURCE 1: CustomerActivity (existing service-managed table).
//   AUTO entries carry { field, from, to } for customer-record field changes.
//   MANUAL entries carry user-typed notes.
//
// SOURCE 2: AuditLog scoped to entities that belong to this customer.
//   Provides SO lifecycle + content edits (qty/price changes on lines),
//   invoice generation, payment events, CM/RMA status changes, and
//   address/contact/document CRUD events.
//
// DEDUPE (implicit by source separation):
//   - Customer-level field changes → CustomerActivity AUTO only.
//     AuditLog (entityType='Customer') excluded.
//   - CustomerDocument CREATE → CustomerActivity "document_added" only.
//     AuditLog CustomerDocument CREATE excluded.
//   - CustomerActivity CREATE audit rows excluded.
//   - Result: zero overlap between the two sources.
//
// FORENSIC AUDIT LOG: untouched — this is a curated read, not a copy.
// =============================================================================

export type TimelineEntry = {
  id: string;           // 'activity:{id}' | 'audit:{auditLogId}'
  ts: Date;
  actorName: string | null; // null → show AUTO badge
  label: string;        // human-readable one-liner
  href?: string;        // optional deep-link to the related record
};

// Actions that belong to Source 2 for non-line entities. Excludes CREATE
// (handled by Source 1 for Customer/CustomerDocument) and system-internal
// events that have no customer-facing interpretation.
const AUDIT_ACTIONS_OF_INTEREST = new Set<string>([
  AuditAction.CREATE,
  AuditAction.UPDATE,
  AuditAction.DELETE,
  AuditAction.STATUS_CHANGE,
  AuditAction.VOID,
  AuditAction.REVERSE,
  AuditAction.REFUND,
  AuditAction.INVOICE_GENERATED,
  AuditAction.PAYMENT_REVERSED,
  AuditAction.RMA_STATUS_CHANGE,
]);

// Entity types we intentionally exclude from the AuditLog source because
// they are already covered by CustomerActivity.
const EXCLUDED_ENTITY_TYPES = new Set(['Customer', 'CustomerActivity']);

/**
 * Fetch the unified customer activity timeline.
 *
 * Returns `take + 1` entries (if available) so the caller can detect hasMore.
 * Pass `skip` to page through the timeline.
 */
export async function getCustomerTimeline(
  db: PrismaClient,
  customerId: string,
  { skip = 0, take = 100 }: { skip?: number; take?: number } = {},
): Promise<{ entries: TimelineEntry[]; hasMore: boolean }> {
  // ------------------------------------------------------------------
  // 1. Entity metadata — IDs + display fields needed for label/href.
  //    Fetch in parallel; limit to 500 per entity type (far more than
  //    any pilot customer will have; avoids unbounded IN clauses).
  // ------------------------------------------------------------------

  const ENTITY_LIMIT = 500;

  const [
    soRows,
    invoiceRows,
    paymentRows,
    cmRows,
    rmaRows,
    addressRows,
    contactRows,
    docRows,
    activityRows,
  ] = await Promise.all([
    db.salesOrder.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, number: true },
      orderBy: { createdAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
    db.invoice.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, number: true, total: true },
      orderBy: { createdAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
    db.payment.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, number: true, amount: true, method: true },
      orderBy: { receivedAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
    db.creditMemo.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, number: true, netCredit: true },
      orderBy: { createdAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
    db.rma.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, number: true },
      orderBy: { createdAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
    db.customerAddress.findMany({
      where: { customerId },
      select: { id: true, kind: true, label: true },
    }),
    db.customerContact.findMany({
      where: { customerId },
      select: { id: true, name: true },
    }),
    db.customerDocument.findMany({
      where: { customerId },
      select: { id: true, kind: true },
    }),
    db.customerActivity.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: ENTITY_LIMIT,
    }),
  ]);

  // Build lookup maps
  const soId2Number = new Map(soRows.map((r) => [r.id, r.number]));
  const invoiceId2 = new Map(
    invoiceRows.map((r) => [r.id, { number: r.number, total: r.total }]),
  );
  const paymentId2 = new Map(
    paymentRows.map((r) => [r.id, { number: r.number, amount: r.amount, method: r.method }]),
  );
  const cmId2 = new Map(cmRows.map((r) => [r.id, { number: r.number, netCredit: r.netCredit }]));
  const rmaId2Number = new Map(rmaRows.map((r) => [r.id, r.number]));
  const addressId2 = new Map(
    addressRows.map((r) => [r.id, { kind: r.kind, label: r.label }]),
  );
  const contactId2Name = new Map(contactRows.map((r) => [r.id, r.name]));
  const docId2Kind = new Map(docRows.map((r) => [r.id, r.kind]));

  const soIds = soRows.map((r) => r.id);

  // ------------------------------------------------------------------
  // 2. SalesOrderLine metadata — needed to map lineId → SO number.
  // ------------------------------------------------------------------
  const lineRows = soIds.length
    ? await db.salesOrderLine.findMany({
        where: { salesOrderId: { in: soIds }, deletedAt: null },
        select: { id: true, salesOrderId: true },
        take: ENTITY_LIMIT * 10, // SOs can have many lines
      })
    : [];
  const lineId2SoId = new Map(lineRows.map((l) => [l.id, l.salesOrderId]));

  // Entity ID arrays for AuditLog filter
  const invoiceIds = invoiceRows.map((r) => r.id);
  const paymentIds = paymentRows.map((r) => r.id);
  const cmIds = cmRows.map((r) => r.id);
  const rmaIds = rmaRows.map((r) => r.id);
  const addressIds = addressRows.map((r) => r.id);
  const contactIds = contactRows.map((r) => r.id);
  const docIds = docRows.map((r) => r.id);
  const lineIds = lineRows.map((l) => l.id);

  // ------------------------------------------------------------------
  // 3. AuditLog query — single OR-based query across all entity buckets.
  //    Prisma generates efficient per-branch index scans.
  // ------------------------------------------------------------------
  const auditOrClauses: object[] = [];

  if (soIds.length) {
    auditOrClauses.push({ entityType: 'SalesOrder', entityId: { in: soIds } });
  }
  if (lineIds.length) {
    // Line edits only — status changes on SO are included in the SalesOrder bucket above
    auditOrClauses.push({
      entityType: 'SalesOrderLine',
      entityId: { in: lineIds },
      action: AuditAction.UPDATE,
    });
  }
  if (invoiceIds.length) {
    auditOrClauses.push({ entityType: 'Invoice', entityId: { in: invoiceIds } });
  }
  if (paymentIds.length) {
    auditOrClauses.push({ entityType: 'Payment', entityId: { in: paymentIds } });
  }
  if (cmIds.length) {
    auditOrClauses.push({ entityType: 'CreditMemo', entityId: { in: cmIds } });
  }
  if (rmaIds.length) {
    auditOrClauses.push({ entityType: 'Rma', entityId: { in: rmaIds } });
  }
  if (addressIds.length) {
    auditOrClauses.push({ entityType: 'CustomerAddress', entityId: { in: addressIds } });
  }
  if (contactIds.length) {
    auditOrClauses.push({ entityType: 'CustomerContact', entityId: { in: contactIds } });
  }
  if (docIds.length) {
    // Exclude CREATE — covered by CustomerActivity "document_added"
    auditOrClauses.push({
      entityType: 'CustomerDocument',
      entityId: { in: docIds },
      action: { not: AuditAction.CREATE },
    });
  }

  const auditRows = auditOrClauses.length
    ? await db.auditLog.findMany({
        where: { OR: auditOrClauses },
        orderBy: { createdAt: 'desc' },
        take: ENTITY_LIMIT * 3,
      })
    : [];

  // ------------------------------------------------------------------
  // 4. Batch-resolve user names for all unique userIds.
  // ------------------------------------------------------------------
  const userIds = new Set<string>();
  for (const row of auditRows) {
    if (row.userId) userIds.add(row.userId);
  }
  for (const a of activityRows) {
    if (a.createdById) userIds.add(a.createdById);
  }

  const userNameMap = new Map<string, string>();
  if (userIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, name: true },
    });
    for (const u of users) userNameMap.set(u.id, u.name);
  }

  function actorName(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return userNameMap.get(userId) ?? null;
  }

  // ------------------------------------------------------------------
  // 5. Format Source 1 — CustomerActivity entries.
  // ------------------------------------------------------------------
  const source1: TimelineEntry[] = activityRows.map((a) => {
    const detail = parseFieldChange(a.detailJson);
    let label: string;
    if (a.summary === 'customer_created') {
      label = 'Customer created';
    } else if (a.summary === 'document_added') {
      const kindRaw = parseDocKind(a.detailJson);
      label = kindRaw ? `${formatDocKind(kindRaw)} document uploaded` : 'Document uploaded';
    } else if (a.summary.endsWith('_changed') && detail) {
      const field = a.summary.slice(0, -'_changed'.length);
      label = `${humanizeFieldName(field)} changed: ${stringifyFieldValue(detail.from)} → ${stringifyFieldValue(detail.to)}`;
    } else {
      label = humanizeSummary(a.summary);
    }
    return {
      id: `activity:${a.id}`,
      ts: a.createdAt,
      actorName: actorName(a.createdById),
      label,
    };
  });

  // ------------------------------------------------------------------
  // 6. Format Source 2 — AuditLog entries.
  // ------------------------------------------------------------------
  const source2: TimelineEntry[] = [];

  for (const row of auditRows) {
    // Skip excluded entity types (Customer, CustomerActivity)
    if (EXCLUDED_ENTITY_TYPES.has(row.entityType)) continue;
    // Skip actions we don't surface to the customer timeline
    if (!AUDIT_ACTIONS_OF_INTEREST.has(row.action)) continue;

    const after = row.afterJson as Record<string, unknown> | null;
    const before = row.beforeJson as Record<string, unknown> | null;

    let label: string | null = null;
    let href: string | undefined;

    switch (row.entityType) {
      case 'SalesOrder': {
        const soNum = soId2Number.get(row.entityId) ?? row.entityId;
        href = `/sales-orders/${row.entityId}`;
        if (row.action === AuditAction.CREATE) {
          label = `Order ${soNum} created`;
        } else if (row.action === AuditAction.STATUS_CHANGE) {
          const toStatus = strVal(after, 'status');
          label = `${soNum} → ${formatSoStatus(toStatus)}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = formatObjectDiff(`${soNum} edited`, before, after, SO_HEADER_FIELDS);
        } else if (row.action === AuditAction.DELETE) {
          label = `${soNum} deleted`;
        }
        break;
      }

      case 'SalesOrderLine': {
        const soId = lineId2SoId.get(row.entityId);
        const soNum = soId ? (soId2Number.get(soId) ?? soId) : '?';
        href = soId ? `/sales-orders/${soId}` : undefined;
        if (row.action === AuditAction.UPDATE) {
          label = formatLineDiff(soNum, before, after);
        }
        break;
      }

      case 'Invoice': {
        const inv = invoiceId2.get(row.entityId);
        const invNum = inv?.number ?? row.entityId;
        href = `/invoices/${row.entityId}`;
        if (row.action === AuditAction.INVOICE_GENERATED) {
          const total = inv?.total ?? strVal(after, 'total');
          label = `Invoice ${invNum} generated — ${formatCurrency(total)}`;
        } else if (row.action === AuditAction.STATUS_CHANGE || row.action === AuditAction.VOID) {
          const toStatus = strVal(after, 'status');
          const reason = strVal(after, 'voidReason') ?? strVal(row.reason ? { reason: row.reason } : null, 'reason');
          label = toStatus === 'VOIDED'
            ? `Invoice ${invNum} voided${reason ? ` — ${reason}` : ''}`
            : `Invoice ${invNum} → ${formatStatusLabel(toStatus ?? '')}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = `Invoice ${invNum} updated`;
        }
        break;
      }

      case 'Payment': {
        const pmt = paymentId2.get(row.entityId);
        const pmtNum = pmt?.number ?? strVal(after, 'number') ?? row.entityId;
        href = `/payments/${row.entityId}`;
        if (row.action === AuditAction.CREATE) {
          const amount = pmt?.amount ?? strVal(after, 'amount');
          const method = pmt?.method ?? strVal(after, 'method');
          label = `Payment ${pmtNum} received — ${formatCurrency(amount)}${method ? ` via ${formatMethod(method)}` : ''}`;
        } else if (row.action === AuditAction.PAYMENT_REVERSED || row.action === AuditAction.REVERSE) {
          const amount = pmt?.amount;
          label = `Payment ${pmtNum} reversed${amount != null ? ` — ${formatCurrency(amount)}` : ''}`;
          if (row.reason) label += ` (${row.reason})`;
        }
        break;
      }

      case 'CreditMemo': {
        const cm = cmId2.get(row.entityId);
        const cmNum = cm?.number ?? row.entityId;
        href = `/credit-memos/${row.entityId}`;
        if (row.action === AuditAction.CREATE) {
          label = `Credit memo ${cmNum} issued`;
        } else if (row.action === AuditAction.STATUS_CHANGE) {
          const toStatus = strVal(after, 'status');
          label = `Credit memo ${cmNum} → ${formatStatusLabel(toStatus ?? '')}`;
        } else if (row.action === AuditAction.VOID) {
          label = `Credit memo ${cmNum} voided`;
          if (row.reason) label += ` — ${row.reason}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = `Credit memo ${cmNum} updated`;
        }
        break;
      }

      case 'Rma': {
        const rmaNum = rmaId2Number.get(row.entityId) ?? row.entityId;
        href = `/rmas/${row.entityId}`;
        if (row.action === AuditAction.CREATE) {
          label = `RMA ${rmaNum} opened`;
        } else if (
          row.action === AuditAction.STATUS_CHANGE ||
          row.action === AuditAction.RMA_STATUS_CHANGE
        ) {
          const toStatus = strVal(after, 'status');
          label = `RMA ${rmaNum} → ${formatRmaStatus(toStatus)}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = `RMA ${rmaNum} updated`;
        }
        break;
      }

      case 'CustomerAddress': {
        const addr = addressId2.get(row.entityId);
        const addrLabel = addr
          ? `${addr.kind === 'BILLING' ? 'billing' : 'shipping'} address${addr.label ? ` "${addr.label}"` : ''}`
          : 'address';
        if (row.action === AuditAction.CREATE) {
          label = `Added ${addrLabel}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = `Updated ${addrLabel}`;
        } else if (row.action === AuditAction.DELETE) {
          label = `Removed ${addrLabel}`;
        }
        break;
      }

      case 'CustomerContact': {
        const name = contactId2Name.get(row.entityId);
        const contactDesc = name ? `contact "${name}"` : 'contact';
        if (row.action === AuditAction.CREATE) {
          label = `Added ${contactDesc}`;
        } else if (row.action === AuditAction.UPDATE) {
          label = `Updated ${contactDesc}`;
        } else if (row.action === AuditAction.DELETE) {
          label = `Removed ${contactDesc}`;
        }
        break;
      }

      case 'CustomerDocument': {
        // CREATE excluded from AuditLog (covered by CustomerActivity "document_added")
        const kind = docId2Kind.get(row.entityId);
        const docDesc = kind ? `${formatDocKind(kind)} document` : 'document';
        if (row.action === AuditAction.UPDATE) {
          label = `Updated ${docDesc}`;
        } else if (row.action === AuditAction.DELETE) {
          label = `Removed ${docDesc}`;
        }
        break;
      }
    }

    if (label) {
      source2.push({
        id: `audit:${row.id}`,
        ts: row.createdAt,
        actorName: actorName(row.userId),
        label,
        href,
      });
    }
  }

  // ------------------------------------------------------------------
  // 7. Merge, sort newest-first, paginate.
  // ------------------------------------------------------------------
  const all = [...source1, ...source2].sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const sliced = all.slice(skip, skip + take + 1);
  const hasMore = sliced.length > take;

  return { entries: sliced.slice(0, take), hasMore };
}

// =============================================================================
// Formatting helpers
// =============================================================================

function strVal(obj: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  if (v == null) return undefined;
  return String(v);
}

// SO header fields we care about for diff display (excludes internal flags)
const SO_HEADER_FIELDS = new Set([
  'customerPo',
  'promisedShipDate',
  'shippingAddress',
  'customerNotes',
  'internalNotes',
  'orderDiscountPercent',
  'orderDiscountAmount',
  'shippingAmount',
  'handlingAmount',
]);

/**
 * Compare before/after JSON objects and produce a readable label.
 * For single-field changes: shows field name + from → to.
 * For multi-field: shows "{prefix} — N fields changed".
 */
function formatObjectDiff(
  prefix: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  relevantFields?: Set<string>,
): string {
  if (!before || !after) return prefix;
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (relevantFields && !relevantFields.has(key)) continue;
    const fromVal = before[key];
    const toVal = after[key];
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes.push({ field: key, from: fromVal, to: toVal });
    }
  }
  if (changes.length === 0) return prefix;
  if (changes.length === 1) {
    const { field, from, to } = changes[0];
    return `${prefix} — ${humanizeFieldName(field)}: ${stringifyFieldValue(from)} → ${stringifyFieldValue(to)}`;
  }
  return `${prefix} — ${changes.length} fields changed`;
}

/**
 * Format a SalesOrderLine UPDATE diff into a readable label.
 * Priority: qty change, then price change, then discount, then note.
 */
function formatLineDiff(
  soNumber: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string {
  const prefix = `${soNumber} line edited`;
  if (!before || !after) return prefix;

  const changes: string[] = [];

  const qtyBefore = before.qtyOrdered;
  const qtyAfter = after.qtyOrdered;
  if (JSON.stringify(qtyBefore) !== JSON.stringify(qtyAfter)) {
    changes.push(`qty ${stringifyFieldValue(qtyBefore)} → ${stringifyFieldValue(qtyAfter)}`);
  }

  const priceBefore = before.unitPrice;
  const priceAfter = after.unitPrice;
  if (JSON.stringify(priceBefore) !== JSON.stringify(priceAfter)) {
    changes.push(
      `price ${formatCurrency(priceBefore as string)} → ${formatCurrency(priceAfter as string)}`,
    );
  }

  const discPctBefore = before.discountPercent;
  const discPctAfter = after.discountPercent;
  if (JSON.stringify(discPctBefore) !== JSON.stringify(discPctAfter)) {
    changes.push(
      `discount ${stringifyFieldValue(discPctBefore)}% → ${stringifyFieldValue(discPctAfter)}%`,
    );
  }

  if (changes.length === 0) {
    // Fallback: count all differences
    const totalDiffs = Object.keys({ ...before, ...after }).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    ).length;
    return totalDiffs > 0 ? `${prefix} — ${totalDiffs} fields changed` : prefix;
  }

  if (changes.length === 1) return `${prefix} — ${changes[0]}`;
  return `${prefix} — ${changes.join(', ')}`;
}

function formatSoStatus(status: string | undefined): string {
  switch (status) {
    case 'CONFIRMED': return 'Confirmed';
    case 'DISPATCHED': return 'Dispatched';
    case 'CLOSED': return 'Closed';
    case 'CANCELLED': return 'Cancelled';
    case 'DRAFT': return 'Draft';
    default: return status ? formatStatusLabel(status) : 'unknown status';
  }
}

function formatRmaStatus(status: string | undefined): string {
  switch (status) {
    case 'APPROVED': return 'Approved';
    case 'IN_TRANSIT': return 'In transit';
    case 'RECEIVED': return 'Received';
    case 'INSPECTED': return 'Inspected';
    case 'CREDITED': return 'Credited';
    case 'REJECTED': return 'Rejected';
    default: return status ? formatStatusLabel(status) : 'updated';
  }
}

function formatStatusLabel(s: string): string {
  if (!s) return '';
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

function formatMethod(method: string): string {
  switch (method) {
    case 'CREDIT_CARD': return 'credit card';
    case 'ACH': return 'ACH';
    case 'WIRE': return 'wire';
    case 'CHECK': return 'check';
    case 'CASH': return 'cash';
    case 'MONEY_ORDER': return 'money order';
    case 'APPLIED_CREDIT': return 'applied credit';
    case 'EXTERNAL': return 'external';
    default: return method.toLowerCase();
  }
}

function formatDocKind(kind: string): string {
  switch (kind) {
    case 'EIN': return 'EIN';
    case 'SSN': return 'SSN';
    case 'DRIVERS_LICENSE': return "driver's license";
    case 'RESALE_PERMIT': return 'resale permit';
    case 'BUSINESS_LICENSE': return 'business license';
    case 'RESALE_CERT': return 'resale certificate';
    default: return kind.toLowerCase().replace(/_/g, ' ');
  }
}

function humanizeFieldName(field: string): string {
  const overrides: Record<string, string> = {
    creditLimit: 'Credit limit',
    arHoldDays: 'AR hold days',
    taxExempt: 'Tax exempt',
    resaleCertNumber: 'Resale cert #',
    primaryPhone: 'Primary phone',
    primaryEmail: 'Primary email',
    internalNotes: 'Internal notes',
    costPlusPercent: 'Cost-plus %',
    customerPo: 'Customer PO',
    orderDiscountPercent: 'Order discount %',
    orderDiscountAmount: 'Order discount $',
    shippingAmount: 'Shipping',
    handlingAmount: 'Handling',
    shippingAddress: 'Ship-to address',
    promisedShipDate: 'Promised ship date',
  };
  if (overrides[field]) return overrides[field];
  // camelCase → Title case
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function humanizeSummary(s: string): string {
  if (s.endsWith('_changed')) {
    const field = s.slice(0, -'_changed'.length);
    return `${humanizeFieldName(field)} changed`;
  }
  return s.replace(/_/g, ' ');
}

function stringifyFieldValue(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

type FieldChange = { field: string; from: unknown; to: unknown };

function parseFieldChange(json: unknown): FieldChange | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.field !== 'string') return null;
  return { field: obj.field, from: obj.from, to: obj.to };
}

function parseDocKind(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.kind !== 'string') return null;
  return obj.kind;
}
