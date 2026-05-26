import {
  AuditAction,
  CreditApplicationKind,
  CreditMemoStatus,
  CustomerActivityKind,
  Prisma,
} from '@/generated/tenant';
import type {
  CreditMemo,
  CreditMemoLine,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  createCreditMemoInputSchema,
  updateCreditMemoInputSchema,
  type CreateCreditMemoInput,
  type UpdateCreditMemoInput,
} from '@/lib/validation/invoicing';
import { recomputeAmountPaidForInvoice } from './invoices';

// =============================================================================
// CreditMemo service.
//
// Three states:
//   DRAFT     — created, no GL effect, no AR effect. Editable in principle.
//   CONFIRMED — posted to GL, AR reduced. From here it can be applied to
//               invoices (CREDIT_TO_INVOICE applications).
//   VOIDED    — terminal, with offsetting JE if voided from CONFIRMED.
//
// confirmCreditMemo with invoiceId set auto-creates a single
// CreditApplication of kind=CREDIT_TO_INVOICE for netCredit linked to
// the CM and that invoice. The application carries an internal marker
// in `notes` (AUTO_APPLY_ON_CONFIRM_MARKER) so voidCreditMemo can
// distinguish it from manually-created applications: the auto-app is
// reversed-and-included as part of void; manual apps block void.
//
// JE creation goes through lib/gl/post — never tx.journalEntry.create.
// Every state change is audited.
// =============================================================================

const CM_SEQUENCE_NAME = 'credit_memo';
const CM_PREFIX = 'CM';

const SALES_RETURNS_ACCOUNT = '4500';
const AR_ACCOUNT = '1210';
const RESTOCKING_FEE_INCOME_ACCOUNT = '4600';

const LINE_MATH_TOLERANCE = new Prisma.Decimal('0.001');

// Marker stored in CreditApplication.notes for the application auto-
// created at confirmCreditMemo when invoiceId is set. Distinguishes
// auto-apps from user-created apps so voidCreditMemo can auto-reverse
// the former while still refusing on the latter.
const AUTO_APPLY_ON_CONFIRM_MARKER = '__auto_apply_on_confirm__';

export type CreditMemoWithLines = CreditMemo & { lines: CreditMemoLine[] };

// ---------------------------------------------------------------------------
// createCreditMemoDraft (Tx variant + public wrapper)
// ---------------------------------------------------------------------------

/**
 * Tx variant. Used by the RMA service's creditFromRma flow to compose
 * draft + confirm into one atomic transaction with the RMA transition.
 */
export async function createCreditMemoDraftTx(
  tx: Prisma.TransactionClient,
  input: CreateCreditMemoInput,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  const data = createCreditMemoInputSchema.parse(input);
  const amount = new Prisma.Decimal(data.amount);
  const restockingFee = data.restockingFee != null
    ? new Prisma.Decimal(data.restockingFee)
    : new Prisma.Decimal(0);
  const netCredit = amount.minus(restockingFee);
  if (netCredit.lessThan(0)) {
    throw new Error(
      `restockingFee (${restockingFee.toString()}) cannot exceed amount (${amount.toString()}); netCredit would be negative`,
    );
  }

  // Cross-record math check: SUM(line.qty * line.unitPrice) must equal
  // `amount` (the gross sales-returns recognition) within the documented
  // tolerance. The restocking fee is a SEPARATE charge — it does not
  // affect the line totals. Customer's net credit = amount - fee.
  // Per docs/06-invoicing-ar.md: amount is gross, netCredit = amount - fee.
  const lineSum = data.lines.reduce(
    (acc, l) =>
      acc.plus(new Prisma.Decimal(l.qty).times(new Prisma.Decimal(l.unitPrice))),
    new Prisma.Decimal(0),
  );
  const diff = lineSum.minus(amount).abs();
  if (diff.greaterThan(LINE_MATH_TOLERANCE)) {
    throw new Error(
      `Line totals $${lineSum.toString()} don't match memo amount $${amount.toString()}; difference $${diff.toString()}`,
    );
  }

  const customer = await tx.customer.findFirst({
    where: { id: data.customerId, deletedAt: null },
  });
  if (!customer) throw new Error(`Customer not found: ${data.customerId}`);

  const category = await tx.creditMemoCategory.findFirst({
    where: { id: data.categoryId, deletedAt: null },
  });
  if (!category) throw new Error(`CreditMemoCategory not found: ${data.categoryId}`);
  if (!category.active) {
    throw new Error(`CreditMemoCategory ${category.code} is inactive`);
  }

  if (data.invoiceId) {
    const invoice = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!invoice) throw new Error(`Invoice not found: ${data.invoiceId}`);
    if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
    if (invoice.customerId !== data.customerId) {
      throw new Error(
        `Cross-customer credit memo: customer ${data.customerId} != invoice customer ${invoice.customerId}`,
      );
    }
    // Voided invoices CAN be referenced — refund-via-CM flows hang
    // CMs against invoices that were later voided.
  }

  const seq = await getNextSequence(tx, {
    name: CM_SEQUENCE_NAME,
    prefix: CM_PREFIX,
    useYear: true,
  });

  const cm = await tx.creditMemo.create({
    data: {
      number: seq.formatted,
      customerId: data.customerId,
      invoiceId: data.invoiceId ?? null,
      categoryId: data.categoryId,
      status: CreditMemoStatus.DRAFT,
      amount,
      restockingFee,
      netCredit,
      currency: data.currency ?? 'USD',
      reason: data.reason,
      lines: {
        create: data.lines.map((l) => ({
          invoiceLineId: l.invoiceLineId ?? null,
          variantId: l.variantId,
          qty: new Prisma.Decimal(l.qty),
          unitPrice: new Prisma.Decimal(l.unitPrice),
          lineTotal: new Prisma.Decimal(l.qty).times(new Prisma.Decimal(l.unitPrice)),
          description: l.description,
        })),
      },
    },
    include: { lines: true },
  });

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CreditMemo',
    entityId: cm.id,
    after: cm,
    ctx,
  });

  return cm;
}

export async function createCreditMemoDraft(
  db: PrismaClient,
  input: CreateCreditMemoInput,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  return db.$transaction((tx) => createCreditMemoDraftTx(tx, input, ctx));
}

// ---------------------------------------------------------------------------
// updateCreditMemoDraft — DRAFT-only, replace-all lines pattern
// ---------------------------------------------------------------------------

export async function updateCreditMemoDraft(
  db: PrismaClient,
  creditMemoId: string,
  input: UpdateCreditMemoInput,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  const data = updateCreditMemoInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "CreditMemo" WHERE "id" = ${creditMemoId} FOR UPDATE`;
    const before = await tx.creditMemo.findUnique({
      where: { id: creditMemoId },
      include: { lines: true },
    });
    if (!before) throw new Error(`CreditMemo not found: ${creditMemoId}`);
    if (before.deletedAt) throw new Error('CreditMemo is soft-deleted');
    if (before.status !== CreditMemoStatus.DRAFT) {
      throw new Error(
        `Cannot edit CreditMemo in status ${before.status} (only DRAFT is editable)`,
      );
    }

    // Determine the effective values.
    const nextAmount = data.amount != null
      ? new Prisma.Decimal(data.amount)
      : before.amount;
    const nextRestockingFee = data.restockingFee != null
      ? new Prisma.Decimal(data.restockingFee)
      : before.restockingFee;
    const nextNetCredit = nextAmount.minus(nextRestockingFee);
    if (nextNetCredit.lessThan(0)) {
      throw new Error(
        `restockingFee (${nextRestockingFee.toString()}) cannot exceed amount (${nextAmount.toString()}); netCredit would be negative`,
      );
    }

    // When lines are supplied, re-validate the sum against the
    // effective amount (same tolerance as createCreditMemoDraftTx).
    if (data.lines) {
      const lineSum = data.lines.reduce(
        (acc, l) =>
          acc.plus(
            new Prisma.Decimal(l.qty).times(new Prisma.Decimal(l.unitPrice)),
          ),
        new Prisma.Decimal(0),
      );
      const diff = lineSum.minus(nextAmount).abs();
      if (diff.greaterThan(LINE_MATH_TOLERANCE)) {
        throw new Error(
          `Line totals $${lineSum.toString()} don't match memo amount $${nextAmount.toString()}; difference $${diff.toString()}`,
        );
      }
    }

    // Cross-customer guard: an updated invoiceId must belong to the
    // same customer (matches createCreditMemoDraftTx).
    if (data.invoiceId !== undefined && data.invoiceId !== null) {
      const invoice = await tx.invoice.findUnique({
        where: { id: data.invoiceId },
      });
      if (!invoice) throw new Error(`Invoice not found: ${data.invoiceId}`);
      if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
      if (invoice.customerId !== before.customerId) {
        throw new Error(
          `Cross-customer credit memo: customer ${before.customerId} != invoice customer ${invoice.customerId}`,
        );
      }
    }

    // Category-id swap is allowed on DRAFT. Validate the new category
    // is active.
    if (data.categoryId !== undefined) {
      const category = await tx.creditMemoCategory.findFirst({
        where: { id: data.categoryId, deletedAt: null },
      });
      if (!category)
        throw new Error(`CreditMemoCategory not found: ${data.categoryId}`);
      if (!category.active) {
        throw new Error(`CreditMemoCategory ${category.code} is inactive`);
      }
    }

    if (data.lines) {
      // Hard-delete on DRAFT — no GL or AR consumers can be holding
      // references to a draft's lines (CreditApplication only attaches
      // on confirm).
      await tx.creditMemoLine.deleteMany({
        where: { creditMemoId },
      });
      await tx.creditMemoLine.createMany({
        data: data.lines.map((l) => ({
          creditMemoId,
          invoiceLineId: l.invoiceLineId ?? null,
          variantId: l.variantId,
          qty: new Prisma.Decimal(l.qty),
          unitPrice: new Prisma.Decimal(l.unitPrice),
          lineTotal: new Prisma.Decimal(l.qty).times(
            new Prisma.Decimal(l.unitPrice),
          ),
          description: l.description,
        })),
      });
    }

    const after = await tx.creditMemo.update({
      where: { id: creditMemoId },
      data: {
        invoiceId:
          data.invoiceId !== undefined ? data.invoiceId : before.invoiceId,
        categoryId:
          data.categoryId !== undefined ? data.categoryId : before.categoryId,
        amount: nextAmount,
        restockingFee: nextRestockingFee,
        netCredit: nextNetCredit,
        currency:
          data.currency !== undefined ? data.currency : before.currency,
        reason: data.reason !== undefined ? data.reason : before.reason,
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CreditMemo',
      entityId: creditMemoId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// confirmCreditMemo
// ---------------------------------------------------------------------------

/**
 * Confirm a DRAFT credit memo. Posts the GL JE, sets issuedAt, and (if
 * invoiceId is set) auto-applies the netCredit to the linked invoice
 * via a single CreditApplication carrying the internal AUTO_APPLY_ON_
 * CONFIRM marker.
 *
 * Restock pending: when the category has affectsInventory=true, this
 * function writes a structured CustomerActivity AUTO row of summary
 * 'credit_memo_inventory_restock_pending'. NO inventory movement is
 * created in this slice — the future costing engine slice will replay
 * those activity rows to create FIFO restock layers at the original
 * sale's cost.
 */
/**
 * Tx variant — used by the RMA service's creditFromRma flow to compose
 * confirm into the same transaction as draft creation and the RMA
 * status transition.
 */
export async function confirmCreditMemoTx(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  // Lock the row so concurrent confirms serialize.
  await tx.$executeRaw`SELECT 1 FROM "CreditMemo" WHERE "id" = ${creditMemoId} FOR UPDATE`;

  const before = await tx.creditMemo.findUnique({
    where: { id: creditMemoId },
    include: { lines: true, category: true },
  });
  if (!before) throw new Error(`CreditMemo not found: ${creditMemoId}`);
  if (before.deletedAt) throw new Error('CreditMemo is soft-deleted');
  if (before.status !== CreditMemoStatus.DRAFT) {
    throw new Error(
      `Cannot confirm credit memo in status ${before.status} (only DRAFT can be confirmed)`,
    );
  }

  // Post the GL JE. Math matches docs/08-gl-costing-reporting.md:
    //
    //   DR 4500 Sales Returns       amount
    //   CR 1210 AR                  amount
    //   DR 1210 AR                  restockingFee  (only if > 0)
    //   CR 4600 Restocking Fee Inc  restockingFee  (only if > 0)
    //
    // IMPORTANT — both 4500 and 1210 use `amount` (gross), NOT
    // `netCredit`. Future readers may be tempted to "simplify" by
    // collapsing into 3 legs (DR 4500 / CR 1210 netCredit / CR 4600
    // restockingFee), but that misrepresents the sales-returns
    // recognition: the customer is being credited the FULL gross
    // amount of the return; the restocking fee is a SEPARATE event
    // that charges them back. Booking gross 4500 / gross AR-CR keeps
    // the sales-returns ledger accurate (matches the gross of the
    // original sale being reversed) while the second pair of legs
    // recognizes the restocking-fee income and its corresponding
    // AR re-add — i.e. "customer owes us the fee back."
    //
    // Net effects:
    //   Net Dr 1210 = -amount + restockingFee = -netCredit  ✓
    //   Sum Dr      = amount + restockingFee
    //   Sum Cr      = amount + restockingFee  ✓ balanced
    //
    // gl.post() enforces SUM(Dr) === SUM(Cr) — an earlier spec
    // proposed CR 1210 = netCredit, which would have left a
    // restockingFee imbalance and the helper would have rejected.
  const jeLines: Array<{
    accountCode: string;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
    memo?: string;
  }> = [];
  if (before.amount.greaterThan(0)) {
    jeLines.push({
      accountCode: SALES_RETURNS_ACCOUNT,
      debit: before.amount,
      memo: 'Sales returns (gross credit)',
    });
    jeLines.push({
      accountCode: AR_ACCOUNT,
      credit: before.amount,
      memo: 'AR — credit memo (gross)',
    });
  }
  if (before.restockingFee.greaterThan(0)) {
    jeLines.push({
      accountCode: AR_ACCOUNT,
      debit: before.restockingFee,
      memo: 'AR — restocking fee charged back',
    });
    jeLines.push({
      accountCode: RESTOCKING_FEE_INCOME_ACCOUNT,
      credit: before.restockingFee,
      memo: 'Restocking fee income',
    });
  }
  if (jeLines.length > 0) {
    await post(tx, {
      entityType: 'CreditMemo',
      entityId: before.id,
      description: `Confirm credit memo ${before.number}`,
      lines: jeLines,
    });
  }

  // Flip status + stamp issuedAt.
  const after = await tx.creditMemo.update({
    where: { id: creditMemoId },
    data: {
      status: CreditMemoStatus.CONFIRMED,
      issuedAt: new Date(),
    },
    include: { lines: true },
  });

  // Auto-application when linked to an invoice.
  if (before.invoiceId && before.netCredit.greaterThan(0)) {
    const app = await tx.creditApplication.create({
      data: {
        kind: CreditApplicationKind.CREDIT_TO_INVOICE,
        creditMemoId: before.id,
        invoiceId: before.invoiceId,
        amount: before.netCredit,
        notes: AUTO_APPLY_ON_CONFIRM_MARKER,
        appliedById: ctx?.userId ?? null,
      },
    });
    await tx.creditMemo.update({
      where: { id: creditMemoId },
      data: { appliedAmount: before.netCredit },
    });
    await recomputeAmountPaidForInvoice(tx, before.invoiceId);
    void app;
  }

  // Part 3.5: the previous "credit_memo_inventory_restock_pending"
  // CustomerActivity placeholder lived here. Removed because the real
  // costing-engine work now ships in cogsReversal.ts and runs from
  // creditFromRma. Standalone CMs (created without going through an RMA)
  // are pure-AR by design — there's no goods-back signal to anchor an
  // inventory restoration, so confirmCreditMemoTx no longer writes any
  // inventory-side artifact.

  await audit(tx, {
    action: AuditAction.STATUS_CHANGE,
    entityType: 'CreditMemo',
    entityId: creditMemoId,
    before: { status: before.status },
    after: { status: after.status, issuedAt: after.issuedAt },
    ctx,
  });

  return after;
}

export async function confirmCreditMemo(
  db: PrismaClient,
  creditMemoId: string,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  return db.$transaction((tx) => confirmCreditMemoTx(tx, creditMemoId, ctx));
}

// ---------------------------------------------------------------------------
// voidCreditMemo
// ---------------------------------------------------------------------------

export async function voidCreditMemo(
  db: PrismaClient,
  creditMemoId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<CreditMemoWithLines> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('voidCreditMemo requires a non-empty reason');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "CreditMemo" WHERE "id" = ${creditMemoId} FOR UPDATE`;
    const before = await tx.creditMemo.findUnique({
      where: { id: creditMemoId },
      include: { lines: true },
    });
    if (!before) throw new Error(`CreditMemo not found: ${creditMemoId}`);
    if (before.deletedAt) throw new Error('CreditMemo is soft-deleted');

    if (before.status === CreditMemoStatus.VOIDED) {
      throw new Error('CreditMemo is already VOIDED');
    }

    if (before.status === CreditMemoStatus.DRAFT) {
      // No JE to reverse, no AR effect. Just flip the status.
      const after = await tx.creditMemo.update({
        where: { id: creditMemoId },
        data: {
          status: CreditMemoStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: reason,
        },
        include: { lines: true },
      });
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'CreditMemo',
        entityId: creditMemoId,
        before: { status: before.status },
        after: { status: after.status },
        ctx: { ...ctx, reason },
      });
      return after;
    }

    // CONFIRMED case. Refuse if MANUAL apps exist (auto-apps from
    // confirm carry the internal marker and are auto-reversed below).
    const manualApps = await tx.creditApplication.count({
      where: {
        creditMemoId,
        reversedAt: null,
        // Anything not carrying the auto-apply marker is a manual app.
        OR: [{ notes: null }, { notes: { not: AUTO_APPLY_ON_CONFIRM_MARKER } }],
      },
    });
    if (manualApps > 0) {
      throw new Error(
        'Cannot void confirmed credit memo with applied credit. Reverse the applications first, then void.',
      );
    }

    // Reverse the auto-app (if any) so Invoice.amountCredited
    // recomputes back. recomputeAmountPaidForInvoice picks up the
    // change via SUM(non-reversed apps).
    const autoApps = await tx.creditApplication.findMany({
      where: {
        creditMemoId,
        reversedAt: null,
        notes: AUTO_APPLY_ON_CONFIRM_MARKER,
      },
    });
    const affectedInvoiceIds = new Set<string>();
    const now = new Date();
    for (const app of autoApps) {
      await tx.creditApplication.update({
        where: { id: app.id },
        data: { reversedAt: now },
      });
      affectedInvoiceIds.add(app.invoiceId);
    }
    for (const invoiceId of affectedInvoiceIds) {
      await recomputeAmountPaidForInvoice(tx, invoiceId);
    }

    // Post the offsetting JE — debit/credit swap of the confirmation
    // legs. Original JE retains reversedAt:null (offset, not reversal).
    const reverseLines: Array<{
      accountCode: string;
      debit?: Prisma.Decimal;
      credit?: Prisma.Decimal;
      memo?: string;
    }> = [];
    if (before.amount.greaterThan(0)) {
      reverseLines.push({
        accountCode: SALES_RETURNS_ACCOUNT,
        credit: before.amount,
        memo: 'Reverse sales returns (CM void)',
      });
      reverseLines.push({
        accountCode: AR_ACCOUNT,
        debit: before.amount,
        memo: 'Reverse AR — CM void',
      });
    }
    if (before.restockingFee.greaterThan(0)) {
      reverseLines.push({
        accountCode: AR_ACCOUNT,
        credit: before.restockingFee,
        memo: 'Reverse AR restocking fee (CM void)',
      });
      reverseLines.push({
        accountCode: RESTOCKING_FEE_INCOME_ACCOUNT,
        debit: before.restockingFee,
        memo: 'Reverse restocking fee income (CM void)',
      });
    }
    if (reverseLines.length > 0) {
      await post(tx, {
        entityType: 'CreditMemo',
        entityId: creditMemoId,
        description: `Void of credit memo ${before.number}: ${reason}`,
        lines: reverseLines,
      });
    }

    // Drop CM.appliedAmount back proportionally to the auto-apps that
    // were just reversed (any manual apps would have blocked above).
    const remainingApplied = autoApps.reduce(
      (acc, a) => acc.minus(a.amount),
      before.appliedAmount,
    );
    const after = await tx.creditMemo.update({
      where: { id: creditMemoId },
      data: {
        status: CreditMemoStatus.VOIDED,
        voidedAt: now,
        voidReason: reason,
        appliedAmount: remainingApplied.lessThan(0)
          ? new Prisma.Decimal(0)
          : remainingApplied,
      },
      include: { lines: true },
    });

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'CreditMemo',
      entityId: creditMemoId,
      before: { status: before.status },
      after: { status: after.status, voidedAt: after.voidedAt },
      ctx: { ...ctx, reason },
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getCreditMemo(
  db: PrismaClient,
  creditMemoId: string,
  // Optional data-scope fragment (lib/permissions/scope.creditMemoScopeWhere).
  // Out-of-scope memos resolve to null → caller renders not-found.
  scope?: Prisma.CreditMemoWhereInput,
): Promise<
  | (CreditMemoWithLines & {
      category: { id: string; code: string; label: string; affectsInventory: boolean };
    })
  | null
> {
  return db.creditMemo.findFirst({
    where: { AND: [{ id: creditMemoId, deletedAt: null }, scope ?? {}] },
    include: {
      lines: { where: { deletedAt: null } },
      category: {
        select: { id: true, code: true, label: true, affectsInventory: true },
      },
    },
  });
}

export type CreditMemoListFilters = {
  customerId?: string;
  status?: CreditMemoStatus | CreditMemoStatus[];
  categoryId?: string;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  q?: string;
  // Filter to CMs carrying ANY of these OrderTag ids.
  tagIds?: string[];
  // Data-scope fragment from lib/permissions/scope.creditMemoScopeWhere.
  // ANDed in so a "view own" actor only sees their customers' memos.
  scope?: Prisma.CreditMemoWhereInput;
  skip?: number;
  take?: number;
};

function creditMemoWhere(
  filters: Omit<CreditMemoListFilters, 'skip' | 'take'>,
): Prisma.CreditMemoWhereInput {
  const {
    customerId,
    status,
    categoryId,
    createdAtFrom,
    createdAtTo,
    q,
    tagIds,
    scope,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (createdAtFrom) dateFilter.gte = createdAtFrom;
  if (createdAtTo) dateFilter.lte = createdAtTo;
  const base: Prisma.CreditMemoWhereInput = {
    deletedAt: null,
    ...(customerId ? { customerId } : {}),
    ...(status
      ? { status: Array.isArray(status) ? { in: status } : status }
      : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(createdAtFrom || createdAtTo ? { createdAt: dateFilter } : {}),
    // Substring match on CM number OR customer name (case-insensitive).
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: 'insensitive' as const } },
            { customer: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
    ...(tagIds && tagIds.length > 0
      ? { tags: { some: { tagId: { in: tagIds } } } }
      : {}),
  };
  return scope ? { AND: [base, scope] } : base;
}

export async function listCreditMemos(
  db: PrismaClient,
  filters: CreditMemoListFilters = {},
): Promise<CreditMemoWithLines[]> {
  const { skip = 0, take = 100, ...rest } = filters;
  return db.creditMemo.findMany({
    where: creditMemoWhere(rest),
    include: { lines: { where: { deletedAt: null } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

export async function listCreditMemosPaged(
  db: PrismaClient,
  filters: CreditMemoListFilters = {},
): Promise<{
  rows: Array<
    CreditMemo & {
      lines: CreditMemoLine[];
      customer: { id: string; code: string; name: string };
      category: { id: string; code: string; label: string };
      tags: Array<{ tag: { id: string; name: string } }>;
    }
  >;
  total: number;
}> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = creditMemoWhere(rest);
  const [rows, total] = await Promise.all([
    db.creditMemo.findMany({
      where,
      include: {
        lines: { where: { deletedAt: null } },
        customer: { select: { id: true, code: true, name: true } },
        category: { select: { id: true, code: true, label: true } },
        tags: {
          include: { tag: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(take, 500),
    }),
    db.creditMemo.count({ where }),
  ]);
  return { rows, total };
}
