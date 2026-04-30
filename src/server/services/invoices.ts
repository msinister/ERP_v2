import {
  AuditAction,
  CreditApplicationKind,
  InvoiceStatus,
  Prisma,
  SalesOrderStatus,
} from '@/generated/tenant';
import type {
  Invoice,
  InvoiceLine,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';

// =============================================================================
// Invoices service.
//
// Auto-invoice generation fires from inside closeSalesOrder's transaction
// via generateInvoiceForClosedSOTx — see the SO service. The whole close +
// invoice + JE post is one transaction; if any leg fails the SO close
// rolls back too.
//
// JE creation goes through lib/gl/post — never tx.journalEntry.create.
// Direct mutation of Invoice.amountPaid / amountCredited is forbidden;
// every mutation routes through recomputeAmountPaidForInvoice.
// =============================================================================

const AR_ACCOUNT = '1210';
const SALES_REVENUE_ACCOUNT = '4100';
const SHIPPING_INCOME_ACCOUNT = '4200';
const HANDLING_INCOME_ACCOUNT = '4300';

export type InvoiceWithLines = Invoice & { lines: InvoiceLine[] };

// ---------------------------------------------------------------------------
// generateInvoiceForClosedSOTx — the closeSalesOrder hook
// ---------------------------------------------------------------------------

/**
 * Snapshot a closed SalesOrder into an Invoice + InvoiceLines and post
 * the AR JE. Idempotent: a subsequent call for the same SO returns the
 * existing Invoice without throwing — the @@unique on
 * Invoice.salesOrderId is the race-safe guard.
 *
 * Throws if the SO is not in CLOSED status — this function is meant to
 * be called from inside closeSalesOrder's transaction, after the status
 * flip. Callers from other paths are programmer errors.
 *
 * GL posting:
 *   DR 1210 AR                  total
 *   CR 4100 Sales Revenue       (subtotal − orderDiscount)
 *   CR 4200 Shipping Income     shippingAmount  (only if > 0)
 *   CR 4300 Handling Income     handlingAmount  (only if > 0)
 *
 * No COGS leg. The costing engine slice will retroactively post
 * DR 5100 COGS / CR 1310 Inventory and flip Invoice.cogsPosted=true.
 */
export async function generateInvoiceForClosedSOTx(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  ctx?: AuditContext,
): Promise<InvoiceWithLines> {
  // Idempotency guard: if a non-deleted invoice already exists for this
  // SO, return it. The @@unique constraint makes this race-safe — if a
  // concurrent call slipped past this read, the create would fail with
  // a unique-violation, which the caller can interpret as "already done".
  const existing = await tx.invoice.findFirst({
    where: { salesOrderId, deletedAt: null },
    include: { lines: { where: { deletedAt: null } } },
  });
  if (existing) return existing;

  const so = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      lines: {
        where: { deletedAt: null },
        include: { variant: { include: { product: true } } },
      },
      customer: { select: { id: true } },
    },
  });
  if (!so) throw new Error(`SalesOrder not found: ${salesOrderId}`);
  if (so.status !== SalesOrderStatus.CLOSED) {
    throw new Error(
      `generateInvoiceForClosedSO requires SO in CLOSED status; got ${so.status}`,
    );
  }
  if (so.lines.length === 0) {
    throw new Error('Cannot invoice a SalesOrder with no lines');
  }

  // Compute line totals + subtotal at full Decimal precision. Each line
  // total honors per-line discount: lineTotal = qty * unitPrice, then
  // subtract discountAmount or apply discountPercent.
  const lineRows = so.lines.map((sol) => {
    const qty = sol.qtyOrdered;
    const unitPrice = sol.unitPrice;
    let lineTotal = qty.times(unitPrice);
    if (sol.discountAmount != null) {
      lineTotal = lineTotal.minus(sol.discountAmount);
    } else if (sol.discountPercent != null) {
      lineTotal = lineTotal.minus(
        lineTotal.times(sol.discountPercent).dividedBy(100),
      );
    }
    if (lineTotal.lessThan(0)) lineTotal = new Prisma.Decimal(0);

    const description =
      sol.variant.name ?? sol.variant.product.name;

    return {
      sol,
      data: {
        salesOrderLineId: sol.id,
        variantId: sol.variantId,
        description,
        qty,
        unitPrice,
        discountPercent: sol.discountPercent,
        discountAmount: sol.discountAmount,
        lineTotal,
      },
    };
  });

  const subtotal = lineRows.reduce(
    (acc, r) => acc.plus(r.data.lineTotal),
    new Prisma.Decimal(0),
  );

  // Order-level money. Snapshotted from SO; SO edits after invoice
  // generation cannot mutate posted invoices.
  const orderDiscount =
    so.orderDiscountAmount ??
    (so.orderDiscountPercent != null
      ? subtotal.times(so.orderDiscountPercent).dividedBy(100)
      : new Prisma.Decimal(0));
  const shippingAmount = so.shippingAmount ?? new Prisma.Decimal(0);
  const handlingAmount = so.handlingAmount ?? new Prisma.Decimal(0);

  let total = subtotal.minus(orderDiscount).plus(shippingAmount).plus(handlingAmount);
  if (total.lessThan(0)) total = new Prisma.Decimal(0);

  // Net revenue line (subtotal − orderDiscount). Posted to 4100.
  const netRevenue = subtotal.minus(orderDiscount);

  const invoice = await tx.invoice.create({
    data: {
      number: so.number,
      salesOrderId: so.id,
      customerId: so.customerId,
      warehouseId: so.warehouseId,
      status: InvoiceStatus.OPEN,
      subtotal,
      orderDiscount,
      shippingAmount,
      handlingAmount,
      total,
      currency: so.currency ?? 'USD',
      customerNotes: so.customerNotes,
      internalNotes: so.internalNotes,
      lines: { create: lineRows.map((r) => r.data) },
    },
    include: { lines: { where: { deletedAt: null } } },
  });

  // GL posting. Skip zero-amount credit legs so the JE doesn't carry
  // semantically-meaningless rows.
  const journalLines: Array<{
    accountCode: string;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
    memo?: string;
  }> = [];
  if (total.greaterThan(0)) {
    journalLines.push({ accountCode: AR_ACCOUNT, debit: total, memo: 'AR — invoice' });
  }
  if (netRevenue.greaterThan(0)) {
    journalLines.push({
      accountCode: SALES_REVENUE_ACCOUNT,
      credit: netRevenue,
      memo: 'Sales revenue (net of order discount)',
    });
  }
  if (shippingAmount.greaterThan(0)) {
    journalLines.push({
      accountCode: SHIPPING_INCOME_ACCOUNT,
      credit: shippingAmount,
      memo: 'Shipping',
    });
  }
  if (handlingAmount.greaterThan(0)) {
    journalLines.push({
      accountCode: HANDLING_INCOME_ACCOUNT,
      credit: handlingAmount,
      memo: 'Handling',
    });
  }

  // post() enforces SUM(debits) === SUM(credits). If we somehow assemble
  // an unbalanced set above, the helper throws and the close rolls back.
  if (journalLines.length > 0) {
    await post(tx, {
      entityType: 'Invoice',
      entityId: invoice.id,
      description: `Invoice generated for SO ${so.number}`,
      lines: journalLines,
    });
  }

  await audit(tx, {
    action: AuditAction.INVOICE_GENERATED,
    entityType: 'Invoice',
    entityId: invoice.id,
    after: invoice,
    ctx,
  });

  return invoice;
}

// ---------------------------------------------------------------------------
// recomputeAmountPaidForInvoice — denorm self-heal
// ---------------------------------------------------------------------------

/**
 * Aggregate non-reversed CreditApplication rows for the invoice and
 * recompute amountPaid (PAYMENT_TO_INVOICE) + amountCredited
 * (CREDIT_TO_INVOICE) + status. Self-healing pattern, same as
 * recomputeQtyReceivedForPoLine and recomputeReservedForBin. Service-
 * internal helper — direct mutation of these fields by other paths is
 * forbidden.
 */
export async function recomputeAmountPaidForInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  if (invoice.deletedAt) return;
  // Voided invoices stay voided; their AR effect is offset by the void
  // JE. Don't recompute status if voided.
  if (invoice.status === InvoiceStatus.VOIDED) return;

  const apps = await tx.creditApplication.findMany({
    where: { invoiceId, reversedAt: null },
  });
  let amountPaid = new Prisma.Decimal(0);
  let amountCredited = new Prisma.Decimal(0);
  for (const a of apps) {
    if (a.kind === CreditApplicationKind.PAYMENT_TO_INVOICE) {
      amountPaid = amountPaid.plus(a.amount);
    } else if (a.kind === CreditApplicationKind.CREDIT_TO_INVOICE) {
      amountCredited = amountCredited.plus(a.amount);
    }
  }
  const totalApplied = amountPaid.plus(amountCredited);
  let status: InvoiceStatus;
  if (totalApplied.greaterThanOrEqualTo(invoice.total)) {
    status = InvoiceStatus.PAID;
  } else if (totalApplied.greaterThan(0)) {
    status = InvoiceStatus.PARTIAL;
  } else {
    status = InvoiceStatus.OPEN;
  }
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, amountCredited, status },
  });
}

// ---------------------------------------------------------------------------
// voidInvoice
// ---------------------------------------------------------------------------

export async function voidInvoice(
  db: PrismaClient,
  invoiceId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<InvoiceWithLines> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('voidInvoice requires a non-empty reason');
  }
  return db.$transaction(async (tx) => {
    const before = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!before) throw new Error(`Invoice not found: ${invoiceId}`);
    if (before.deletedAt) throw new Error('Invoice is soft-deleted');
    if (before.status === InvoiceStatus.VOIDED) {
      throw new Error('Invoice is already VOIDED');
    }

    // Refuse if any non-reversed CreditApplication exists. The caller
    // must reverse the applied payments first.
    const liveApps = await tx.creditApplication.count({
      where: { invoiceId, reversedAt: null },
    });
    if (liveApps > 0) {
      throw new Error(
        'Cannot void invoice with applied payments. Reverse the applied payments first, then void.',
      );
    }

    const after = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: reason,
      },
      include: { lines: { where: { deletedAt: null } } },
    });

    // Offsetting JE — debit/credit swap of the original AR JE. We do
    // NOT mark the original JE.reversedAt; we post a separate, visible
    // event so the GL retains both rows. Skip zero-amount legs.
    const netRevenue = before.subtotal.minus(before.orderDiscount);
    const reverseLines: Array<{
      accountCode: string;
      debit?: Prisma.Decimal;
      credit?: Prisma.Decimal;
      memo?: string;
    }> = [];
    if (netRevenue.greaterThan(0)) {
      reverseLines.push({
        accountCode: SALES_REVENUE_ACCOUNT,
        debit: netRevenue,
        memo: 'Reverse sales revenue (void)',
      });
    }
    if (before.shippingAmount.greaterThan(0)) {
      reverseLines.push({
        accountCode: SHIPPING_INCOME_ACCOUNT,
        debit: before.shippingAmount,
        memo: 'Reverse shipping (void)',
      });
    }
    if (before.handlingAmount.greaterThan(0)) {
      reverseLines.push({
        accountCode: HANDLING_INCOME_ACCOUNT,
        debit: before.handlingAmount,
        memo: 'Reverse handling (void)',
      });
    }
    if (before.total.greaterThan(0)) {
      reverseLines.push({
        accountCode: AR_ACCOUNT,
        credit: before.total,
        memo: 'Reverse AR (void)',
      });
    }
    if (reverseLines.length > 0) {
      await post(tx, {
        entityType: 'Invoice',
        entityId: invoiceId,
        description: `Void of invoice ${before.number}: ${reason}`,
        lines: reverseLines,
      });
    }

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'Invoice',
      entityId: invoiceId,
      before: { status: before.status },
      after: { status: after.status, voidedAt: after.voidedAt, voidReason: after.voidReason },
      ctx: { ...ctx, reason },
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getInvoice(
  db: PrismaClient,
  invoiceId: string,
): Promise<
  | (InvoiceWithLines & {
      customer: { id: string; name: string };
      warehouse: { id: string; code: string; name: string };
    })
  | null
> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    include: {
      lines: { where: { deletedAt: null } },
      customer: { select: { id: true, name: true } },
      warehouse: { select: { id: true, code: true, name: true } },
    },
  });
  return invoice;
}

export type InvoiceListFilters = {
  customerId?: string;
  status?: InvoiceStatus | InvoiceStatus[];
  invoiceDateFrom?: Date;
  invoiceDateTo?: Date;
  q?: string; // substring match on number
  skip?: number;
  take?: number;
};

export async function listInvoices(
  db: PrismaClient,
  filters: InvoiceListFilters = {},
): Promise<InvoiceWithLines[]> {
  const {
    customerId,
    status,
    invoiceDateFrom,
    invoiceDateTo,
    q,
    skip = 0,
    take = 100,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (invoiceDateFrom) dateFilter.gte = invoiceDateFrom;
  if (invoiceDateTo) dateFilter.lte = invoiceDateTo;
  return db.invoice.findMany({
    where: {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
      ...(status
        ? { status: Array.isArray(status) ? { in: status } : status }
        : {}),
      ...(invoiceDateFrom || invoiceDateTo ? { invoiceDate: dateFilter } : {}),
      ...(q ? { number: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    include: { lines: { where: { deletedAt: null } } },
    orderBy: { invoiceDate: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

/**
 * Sum of open invoice balances for a customer (computed as
 * total − amountPaid − amountCredited). Excludes VOIDED and
 * soft-deleted. Aging detail (bucket breakdown) lives in a separate
 * helper.
 */
export async function arBalanceForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<Prisma.Decimal> {
  const invoices = await db.invoice.findMany({
    where: {
      customerId,
      deletedAt: null,
      status: { not: InvoiceStatus.VOIDED },
    },
    select: {
      total: true,
      amountPaid: true,
      amountCredited: true,
    },
  });
  return invoices.reduce(
    (acc, i) => acc.plus(i.total).minus(i.amountPaid).minus(i.amountCredited),
    new Prisma.Decimal(0),
  );
}
