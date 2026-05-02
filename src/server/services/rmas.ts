import {
  AuditAction,
  CreditMemoStatus,
  InvoiceStatus,
  Prisma,
  RmaStatus,
} from '@/generated/tenant';
import type { PrismaClient, Rma, RmaLine } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  createRmaInputSchema,
  transitionRmaInputSchema,
  creditFromRmaInputSchema,
  type CreateRmaInput,
  type CreditFromRmaInput,
  type TransitionRmaInput,
} from '@/lib/validation/invoicing';
import {
  createCreditMemoDraftTx,
  confirmCreditMemoTx,
  type CreditMemoWithLines,
} from './creditMemos';
import { reverseCogsForCreditMemoTx } from './cogsReversal';
import {
  getRestockingFeeDefault,
  resolveRestockingFee,
} from './restockingFee';

// =============================================================================
// RMA service.
//
// State machine encoded as a const transition table — declarative, not
// branching code. Tests assert it exhaustively (legal + illegal pairs).
// Returnless guard layered on top of the table.
//
// CREDITED is reached only via creditFromRma — an atomic flow that
// drafts + confirms the CreditMemo, links it back to the RMA, bumps
// the affected InvoiceLine.qtyReturned counters, and stamps creditedAt
// — all in one transaction. If any step fails the entire operation
// rolls back, including the qtyReturned bumps (so a re-credit attempt
// of the same line is impossible).
//
// JE creation goes through gl.post via creditMemos.confirmCreditMemoTx;
// RMAs themselves do NOT post JEs.
// =============================================================================

const RMA_SEQUENCE_NAME = 'rma';
const RMA_PREFIX = 'RMA';

const RETURN_CATEGORY_CODE = 'RETURN';

export const RMA_TRANSITIONS: Record<RmaStatus, RmaStatus[]> = {
  PENDING: [RmaStatus.APPROVED, RmaStatus.REJECTED],
  APPROVED: [RmaStatus.IN_TRANSIT, RmaStatus.RECEIVED, RmaStatus.REJECTED],
  IN_TRANSIT: [RmaStatus.RECEIVED, RmaStatus.REJECTED],
  RECEIVED: [RmaStatus.INSPECTED, RmaStatus.REJECTED],
  INSPECTED: [RmaStatus.CREDITED, RmaStatus.REJECTED],
  CREDITED: [],
  REJECTED: [],
};

export type RmaWithLines = Rma & { lines: RmaLine[] };

// ---------------------------------------------------------------------------
// createRma
// ---------------------------------------------------------------------------

export async function createRma(
  db: PrismaClient,
  input: CreateRmaInput,
  ctx?: AuditContext,
): Promise<RmaWithLines> {
  const data = createRmaInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: data.customerId, deletedAt: null },
    });
    if (!customer) throw new Error(`Customer not found: ${data.customerId}`);

    const invoice = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!invoice) throw new Error(`Invoice not found: ${data.invoiceId}`);
    if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
    if (invoice.status === InvoiceStatus.VOIDED) {
      throw new Error('Cannot RMA a VOIDED invoice');
    }
    if (invoice.customerId !== data.customerId) {
      throw new Error(
        `Cross-customer RMA: customer ${data.customerId} != invoice customer ${invoice.customerId}`,
      );
    }

    // Validate each RMA line: invoice line exists on this invoice and
    // has enough remaining unreturned qty.
    const invoiceLineIds = data.lines.map((l) => l.invoiceLineId);
    const invoiceLines = await tx.invoiceLine.findMany({
      where: { id: { in: invoiceLineIds }, deletedAt: null },
    });
    const ilById = new Map(invoiceLines.map((il) => [il.id, il]));
    for (const line of data.lines) {
      const il = ilById.get(line.invoiceLineId);
      if (!il) {
        throw new Error(`InvoiceLine not found: ${line.invoiceLineId}`);
      }
      if (il.invoiceId !== data.invoiceId) {
        throw new Error(
          `InvoiceLine ${line.invoiceLineId} does not belong to invoice ${data.invoiceId}`,
        );
      }
      const remaining = il.qty.minus(il.qtyReturned);
      const requested = new Prisma.Decimal(line.qty);
      if (requested.greaterThan(remaining)) {
        throw new Error(
          `RMA line qty ${requested.toString()} exceeds remaining unreturned qty ${remaining.toString()} on invoice line ${line.invoiceLineId}`,
        );
      }
    }

    const seq = await getNextSequence(tx, {
      name: RMA_SEQUENCE_NAME,
      prefix: RMA_PREFIX,
      useYear: true,
    });

    const rma = await tx.rma.create({
      data: {
        number: seq.formatted,
        customerId: data.customerId,
        invoiceId: data.invoiceId,
        status: RmaStatus.PENDING,
        returnless: data.returnless ?? false,
        reason: data.reason,
        restockingFeePercent:
          data.restockingFeePercent != null
            ? new Prisma.Decimal(data.restockingFeePercent)
            : null,
        restockingFeeFlat:
          data.restockingFeeFlat != null
            ? new Prisma.Decimal(data.restockingFeeFlat)
            : null,
        lines: {
          create: data.lines.map((l) => ({
            invoiceLineId: l.invoiceLineId,
            qty: new Prisma.Decimal(l.qty),
            reason: l.reason ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Rma',
      entityId: rma.id,
      after: rma,
      ctx,
    });

    return rma;
  });
}

// ---------------------------------------------------------------------------
// transitionRma
// ---------------------------------------------------------------------------

export async function transitionRma(
  db: PrismaClient,
  input: TransitionRmaInput,
  ctx?: AuditContext,
): Promise<Rma> {
  const data = transitionRmaInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Rma" WHERE "id" = ${data.rmaId} FOR UPDATE`;
    const before = await tx.rma.findUnique({ where: { id: data.rmaId } });
    if (!before) throw new Error(`Rma not found: ${data.rmaId}`);
    if (before.deletedAt) throw new Error('Rma is soft-deleted');

    const allowedNext = RMA_TRANSITIONS[before.status];
    if (!allowedNext.includes(data.to)) {
      throw new Error(
        `Illegal RMA transition: ${before.status} → ${data.to} (legal: ${allowedNext.join(', ') || '(terminal)'})`,
      );
    }

    // Returnless guard — these RMAs skip the IN_TRANSIT step. They go
    // APPROVED → RECEIVED directly per docs/06-invoicing-ar.md.
    if (
      before.returnless &&
      before.status === RmaStatus.APPROVED &&
      data.to === RmaStatus.IN_TRANSIT
    ) {
      throw new Error(
        'Returnless RMA cannot transition to IN_TRANSIT; go APPROVED → RECEIVED directly',
      );
    }

    // creditFromRma owns INSPECTED → CREDITED. Calling transitionRma
    // directly for that target would skip the CM creation; reject it.
    if (data.to === RmaStatus.CREDITED) {
      throw new Error(
        'Use creditFromRma to transition to CREDITED — it atomically creates the CreditMemo + bumps qtyReturned',
      );
    }

    const now = new Date();
    const updateData: Prisma.RmaUpdateInput = { status: data.to };
    switch (data.to) {
      case RmaStatus.APPROVED:
        updateData.approvedAt = now;
        break;
      case RmaStatus.IN_TRANSIT:
        // No timestamp field for IN_TRANSIT in the schema — status flag is enough.
        break;
      case RmaStatus.RECEIVED:
        updateData.receivedAt = now;
        break;
      case RmaStatus.INSPECTED:
        updateData.inspectedAt = now;
        break;
      case RmaStatus.REJECTED:
        if (!data.reason || data.reason.trim().length === 0) {
          // Validation enforces this too; safety net.
          throw new Error('REJECTED transition requires a non-empty reason');
        }
        updateData.rejectedAt = now;
        updateData.rejectedReason = data.reason;
        break;
      default:
        break;
    }

    const after = await tx.rma.update({ where: { id: data.rmaId }, data: updateData });

    await audit(tx, {
      action: AuditAction.RMA_STATUS_CHANGE,
      entityType: 'Rma',
      entityId: data.rmaId,
      before: { status: before.status },
      after: { status: after.status },
      ctx: { ...ctx, reason: data.reason ?? ctx?.reason ?? null },
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// creditFromRma
// ---------------------------------------------------------------------------

export type CreditFromRmaResult = {
  rma: RmaWithLines;
  creditMemo: CreditMemoWithLines;
};

/**
 * Atomic INSPECTED → CREDITED transition. In one transaction:
 *   - Validates RMA is INSPECTED, lines align with input.
 *   - Resolves restocking fee (RMA override → admin default → none) and
 *     computes the actual fee dollar amount.
 *   - Drafts a CreditMemo (categoryId = RETURN per pilot constraint).
 *   - Confirms the CM (posts JE, sets issuedAt, auto-applies to invoice).
 *   - Bumps each affected InvoiceLine.qtyReturned by the RMA line qty.
 *   - Links cm.id back to RMA, sets creditedAt, status = CREDITED.
 *
 * The qtyReturned bump is INSIDE this transaction by design — if it
 * succeeded outside the tx, a partial-failure scenario could let you
 * re-credit the same invoice line.
 */
export async function creditFromRma(
  db: PrismaClient,
  rmaId: string,
  input: CreditFromRmaInput,
  ctx?: AuditContext,
): Promise<CreditFromRmaResult> {
  const data = creditFromRmaInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Rma" WHERE "id" = ${rmaId} FOR UPDATE`;
    const rma = await tx.rma.findUnique({
      where: { id: rmaId },
      include: { lines: true },
    });
    if (!rma) throw new Error(`Rma not found: ${rmaId}`);
    if (rma.deletedAt) throw new Error('Rma is soft-deleted');
    if (rma.status !== RmaStatus.INSPECTED) {
      throw new Error(
        `creditFromRma requires RMA in INSPECTED status; got ${rma.status}`,
      );
    }

    // Validate each input line aligns with an existing RMA line and
    // doesn't exceed its qty.
    const rmaLineByInvoiceLine = new Map(
      rma.lines.map((l) => [l.invoiceLineId, l]),
    );
    let lineGrossSum = new Prisma.Decimal(0);
    for (const line of data.lines) {
      const rmaLine = rmaLineByInvoiceLine.get(line.invoiceLineId);
      if (!rmaLine) {
        throw new Error(
          `Input line invoiceLineId ${line.invoiceLineId} does not match any RMA line`,
        );
      }
      const qty = new Prisma.Decimal(line.qty);
      if (qty.greaterThan(rmaLine.qty)) {
        throw new Error(
          `creditFromRma line qty ${qty.toString()} exceeds RMA line qty ${rmaLine.qty.toString()} for invoiceLine ${line.invoiceLineId}`,
        );
      }
      lineGrossSum = lineGrossSum.plus(qty.times(new Prisma.Decimal(line.unitPrice)));
    }

    // Resolve restocking fee. RMA override beats admin default beats none.
    const defaults = await getRestockingFeeDefault(db);
    const fee = resolveRestockingFee(
      {
        percent: rma.restockingFeePercent ?? null,
        flat: rma.restockingFeeFlat ?? null,
      },
      defaults,
    );
    let restockingFeeAmount = new Prisma.Decimal(0);
    if (fee.flat != null) {
      restockingFeeAmount = fee.flat;
    } else if (fee.percent != null) {
      restockingFeeAmount = lineGrossSum.times(fee.percent).dividedBy(100);
    }
    // Per docs/06-invoicing-ar.md: amount is the GROSS sales-returns
    // recognition (= lineGrossSum). restockingFee is a separate charge.
    // The CM service computes netCredit = amount - fee, which is the
    // customer's actual AR reduction. CM line invariant: SUM(line.qty *
    // unitPrice) === amount (fee is NOT included in the line sum).
    const amount = lineGrossSum;
    if (restockingFeeAmount.greaterThan(amount)) {
      throw new Error(
        `Resolved restocking fee ${restockingFeeAmount.toString()} exceeds line gross ${lineGrossSum.toString()}`,
      );
    }

    // Resolve the CM category. Caller may override via input.categoryId
    // (Part 3.5) to drive a loss-reclassification reversal path; defaults
    // to RETURN for backward compatibility with pre-3.5 callers.
    const categoryWhere = data.categoryId
      ? { id: data.categoryId, deletedAt: null }
      : { code: RETURN_CATEGORY_CODE, deletedAt: null };
    const category = await tx.creditMemoCategory.findFirst({
      where: categoryWhere,
    });
    if (!category) {
      throw new Error(
        data.categoryId
          ? `CreditMemoCategory not found: id=${data.categoryId}`
          : `RETURN category not found — seeded categories may have been altered`,
      );
    }

    // Get the invoice line variantIds for the draft CM lines (CM lines
    // require variantId; we look it up from the invoice line).
    const invoiceLineIds = data.lines.map((l) => l.invoiceLineId);
    const invoiceLines = await tx.invoiceLine.findMany({
      where: { id: { in: invoiceLineIds }, deletedAt: null },
    });
    const ilById = new Map(invoiceLines.map((il) => [il.id, il]));

    // Draft + confirm the CM.
    const draft = await createCreditMemoDraftTx(
      tx,
      {
        customerId: rma.customerId,
        invoiceId: rma.invoiceId,
        categoryId: category.id,
        amount: amount.toString(),
        restockingFee: restockingFeeAmount.toString(),
        reason: data.reason ?? `From RMA ${rma.number}`,
        lines: data.lines.map((l) => {
          const il = ilById.get(l.invoiceLineId);
          if (!il) {
            throw new Error(`InvoiceLine vanished: ${l.invoiceLineId}`);
          }
          return {
            invoiceLineId: l.invoiceLineId,
            variantId: il.variantId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            description: l.description,
          };
        }),
      },
      ctx,
    );
    const confirmed = await confirmCreditMemoTx(tx, draft.id, ctx);

    // Establish the RMA→CM link BEFORE reverseCogsForCreditMemoTx fires —
    // the reversal's routing decision reads cm.rma to determine goods-back
    // vs loss-reclass vs pure-AR. Without the link, cm.rma resolves null
    // and routing collapses incorrectly into pure-AR.
    const updatedRma = await tx.rma.update({
      where: { id: rmaId },
      data: {
        status: RmaStatus.CREDITED,
        creditedAt: new Date(),
        creditMemoId: confirmed.id,
      },
      include: { lines: true },
    });

    // Part 3.5: COGS reversal. Self-routing — reads cm.category.lossAccountId
    // and the CM's RMA state to choose goods-back / loss-reclass / pure-AR.
    // Inside the same tx so AR-side CM confirm + COGS reversal commit
    // atomically.
    await reverseCogsForCreditMemoTx(tx, confirmed.id, ctx);

    // Bump qtyReturned on each affected invoice line.
    for (const line of data.lines) {
      const qty = new Prisma.Decimal(line.qty);
      await tx.invoiceLine.update({
        where: { id: line.invoiceLineId },
        data: { qtyReturned: { increment: qty } },
      });
    }

    await audit(tx, {
      action: AuditAction.RMA_STATUS_CHANGE,
      entityType: 'Rma',
      entityId: rmaId,
      before: { status: RmaStatus.INSPECTED },
      after: { status: updatedRma.status, creditMemoId: confirmed.id },
      ctx,
    });

    // Re-fetch CM so the returned creditMemo reflects post-reversal state.
    // reverseCogsForCreditMemoTx mutates cm.cogsReversed; the `confirmed`
    // snapshot captured before that call is stale. Include lines to match
    // the CreditMemoWithLines return type.
    const finalCm = await tx.creditMemo.findUniqueOrThrow({
      where: { id: confirmed.id },
      include: { lines: true },
    });

    return { rma: updatedRma, creditMemo: finalCm };
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getRma(
  db: PrismaClient,
  rmaId: string,
): Promise<(RmaWithLines & { creditMemo: { id: string; number: string } | null }) | null> {
  return db.rma.findFirst({
    where: { id: rmaId, deletedAt: null },
    include: {
      lines: { where: { deletedAt: null } },
      creditMemo: { select: { id: true, number: true } },
    },
  });
}

export type RmaListFilters = {
  customerId?: string;
  invoiceId?: string;
  status?: RmaStatus | RmaStatus[];
  createdAtFrom?: Date;
  createdAtTo?: Date;
  skip?: number;
  take?: number;
};

export async function listRmas(
  db: PrismaClient,
  filters: RmaListFilters = {},
): Promise<RmaWithLines[]> {
  const {
    customerId,
    invoiceId,
    status,
    createdAtFrom,
    createdAtTo,
    skip = 0,
    take = 100,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (createdAtFrom) dateFilter.gte = createdAtFrom;
  if (createdAtTo) dateFilter.lte = createdAtTo;
  return db.rma.findMany({
    where: {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
      ...(invoiceId ? { invoiceId } : {}),
      ...(status
        ? { status: Array.isArray(status) ? { in: status } : status }
        : {}),
      ...(createdAtFrom || createdAtTo ? { createdAt: dateFilter } : {}),
    },
    include: { lines: { where: { deletedAt: null } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

// Re-export the credit-memo type used in the response shape so callers
// can import it from one place.
export type { CreditMemoWithLines, CreditMemoStatus };
