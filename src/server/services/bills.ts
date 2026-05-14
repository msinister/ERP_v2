import {
  AccountType,
  AuditAction,
  BillPaymentStatus,
  BillSource,
  BillStatus,
  Prisma,
} from '@/generated/tenant';
import type {
  Bill,
  BillLine,
  BillReceipt,
  BillPurchaseOrder,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  createBillInputSchema,
  updateBillInputSchema,
  type BillLineInput,
  type CreateBillInput,
  type UpdateBillInput,
} from '@/lib/validation/ap';

// =============================================================================
// Bill (AP) service. Spec: docs/07-accounts-payable.md.
//
// Three states:
//   DRAFT     — created, no GL effect, no AP effect. Editable in full.
//   CONFIRMED — posted to GL (CR 2010 Accounts Payable), dueDate set
//               from vendor's payment term. Lines/totals immutable.
//   CANCELLED — terminal. From DRAFT: just flips status. From CONFIRMED:
//               offsetting JE posted; refused if amountPaid+amountCredited > 0.
//
// Pilot scope: header-level freight/tax must be 0. Per-line landed cost
// goes through landedCost.ts; header-level freight/tax with default-GL
// posting lands in a future slice. Validation enforces the zero rule.
//
// All Decimal math via Prisma.Decimal — never JS Number. JE posting via
// lib/gl/post() — never tx.journalEntry.create directly. Audit via
// audit() helper — never tx.auditLog.create directly.
// =============================================================================

const BILL_SEQUENCE_NAME = 'bill';
const BILL_PREFIX = 'BILL';

const ACCRUED_RECEIPTS_ACCOUNT = '2020';
const AP_ACCOUNT = '2010';

const LINE_MATH_TOLERANCE = new Prisma.Decimal('0.001');

export type BillWithLines = Bill & {
  lines: BillLine[];
  receipts: BillReceipt[];
  purchaseOrders: BillPurchaseOrder[];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeDueDate(billDate: Date, netDays: number | null | undefined): Date | null {
  // null/undefined netDays → no payment term set on vendor → leave null
  // (aging treats null as billDate). Matches the AR-side semantic for
  // COD/Prepay (netDays === null → due immediately on the invoice date).
  if (netDays == null) return null;
  const due = new Date(billDate);
  due.setUTCDate(due.getUTCDate() + netDays);
  return due;
}

function deriveLineTotals(
  lines: ReadonlyArray<BillLineInput>,
): { lines: Array<BillLineInput & { lineTotal: Prisma.Decimal }>; subtotal: Prisma.Decimal } {
  let subtotal = new Prisma.Decimal(0);
  const out = lines.map((l) => {
    const qty = new Prisma.Decimal(l.qty);
    const unitCost = new Prisma.Decimal(l.unitCost);
    const lineTotal = qty.times(unitCost);
    subtotal = subtotal.plus(lineTotal);
    return { ...l, lineTotal };
  });
  return { lines: out, subtotal };
}

async function validateLineRefsTx(
  tx: Prisma.TransactionClient,
  args: {
    vendorId: string;
    source: BillSource;
    lines: ReadonlyArray<BillLineInput>;
  },
): Promise<void> {
  // Variant + receiptLine refs (PRODUCT path).
  const variantIds = Array.from(
    new Set(args.lines.map((l) => l.variantId).filter((v): v is string => v != null)),
  );
  const receiptLineIds = Array.from(
    new Set(args.lines.map((l) => l.receiptLineId).filter((v): v is string => v != null)),
  );
  const expenseAccountIds = Array.from(
    new Set(
      args.lines.map((l) => l.expenseAccountId).filter((v): v is string => v != null),
    ),
  );

  if (variantIds.length > 0) {
    const found = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, deletedAt: null },
      select: { id: true },
    });
    const foundIds = new Set(found.map((v) => v.id));
    const missing = variantIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`ProductVariant not found or soft-deleted: ${missing.join(', ')}`);
    }
  }

  if (receiptLineIds.length > 0) {
    const found = await tx.receiptLine.findMany({
      where: { id: { in: receiptLineIds }, deletedAt: null },
      select: { id: true, receipt: { select: { vendorId: true } } },
    });
    const foundIds = new Set(found.map((r) => r.id));
    const missing = receiptLineIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`ReceiptLine not found or soft-deleted: ${missing.join(', ')}`);
    }
    // Cross-vendor guard: a receipt-line reference must point at a
    // receipt for the SAME vendor as the bill.
    const wrongVendor = found.filter((r) => r.receipt.vendorId !== args.vendorId);
    if (wrongVendor.length > 0) {
      throw new Error(
        `Cross-vendor receipt link: receiptLine(s) ${wrongVendor
          .map((r) => r.id)
          .join(', ')} belong to a different vendor`,
      );
    }
  }

  if (expenseAccountIds.length > 0) {
    const found = await tx.glAccount.findMany({
      where: { id: { in: expenseAccountIds }, deletedAt: null },
      select: { id: true, code: true, type: true, active: true },
    });
    const foundIds = new Set(found.map((a) => a.id));
    const missing = expenseAccountIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`GlAccount not found or soft-deleted: ${missing.join(', ')}`);
    }
    const nonExpense = found.filter((a) => a.type !== AccountType.EXPENSE);
    if (nonExpense.length > 0) {
      throw new Error(
        `Non-expense GlAccount on EXPENSE bill: ${nonExpense
          .map((a) => `${a.code} (${a.type})`)
          .join(', ')}`,
      );
    }
    const inactive = found.filter((a) => !a.active);
    if (inactive.length > 0) {
      throw new Error(
        `Inactive GlAccount: ${inactive.map((a) => a.code).join(', ')}`,
      );
    }
  }
}

async function deriveJoinedRefsTx(
  tx: Prisma.TransactionClient,
  args: { lines: ReadonlyArray<BillLineInput & { lineTotal: Prisma.Decimal }> },
): Promise<{ receiptIds: string[]; purchaseOrderIds: string[] }> {
  // Walk receiptLineId → receiptId + purchaseOrderId. Used to populate
  // BillReceipt + BillPurchaseOrder join rows on create. Lines without
  // a receiptLineId contribute nothing — the operator can manually link
  // a bill to receipts/POs in a future UI slice.
  const receiptLineIds = args.lines
    .map((l) => l.receiptLineId)
    .filter((v): v is string => v != null);
  if (receiptLineIds.length === 0) {
    return { receiptIds: [], purchaseOrderIds: [] };
  }
  const rows = await tx.receiptLine.findMany({
    where: { id: { in: receiptLineIds } },
    select: {
      receiptId: true,
      purchaseOrderLine: { select: { purchaseOrderId: true } },
    },
  });
  const receiptIds = Array.from(new Set(rows.map((r) => r.receiptId)));
  const purchaseOrderIds = Array.from(
    new Set(
      rows
        .map((r) => r.purchaseOrderLine?.purchaseOrderId)
        .filter((v): v is string => v != null),
    ),
  );
  return { receiptIds, purchaseOrderIds };
}

// ---------------------------------------------------------------------------
// createBill
// ---------------------------------------------------------------------------

export async function createBillTx(
  tx: Prisma.TransactionClient,
  input: CreateBillInput,
  ctx?: AuditContext,
  options?: { auditAction?: AuditAction },
): Promise<BillWithLines> {
  const data = createBillInputSchema.parse(input);
  const source = data.source ?? BillSource.PRODUCT;
  const billDate = data.billDate ?? new Date();
  const freight = new Prisma.Decimal(data.freight ?? 0);
  const tax = new Prisma.Decimal(data.tax ?? 0);

  // Pilot guard: header freight/tax not yet wired to GL. Validation
  // schema permits non-negative; service rejects > 0. Future slice
  // will route these through default-GL accounts.
  if (freight.greaterThan(0) || tax.greaterThan(0)) {
    throw new Error(
      `Header freight/tax must be 0 in pilot scope (freight=${freight.toString()}, tax=${tax.toString()}). Use per-line landedCost or expense-source bill.`,
    );
  }

  const vendor = await tx.vendor.findFirst({
    where: { id: data.vendorId, deletedAt: null },
    select: { id: true, paymentTermId: true },
  });
  if (!vendor) throw new Error(`Vendor not found: ${data.vendorId}`);

  await validateLineRefsTx(tx, { vendorId: vendor.id, source, lines: data.lines });

  const { lines, subtotal } = deriveLineTotals(data.lines);
  const total = subtotal.plus(freight).plus(tax);

  const seq = await getNextSequence(tx, {
    name: BILL_SEQUENCE_NAME,
    prefix: BILL_PREFIX,
    useYear: true,
  });

  const { receiptIds, purchaseOrderIds } = await deriveJoinedRefsTx(tx, { lines });

  const bill = await tx.bill.create({
    data: {
      number: seq.formatted,
      vendorId: vendor.id,
      vendorReference: data.vendorReference ?? null,
      source,
      billDate,
      subtotal,
      freight,
      tax,
      total,
      currency: data.currency ?? 'USD',
      notes: data.notes ?? null,
      createdById: ctx?.userId ?? null,
      lines: {
        create: lines.map((l, idx) => ({
          lineNumber: idx + 1,
          variantId: l.variantId ?? null,
          receiptLineId: l.receiptLineId ?? null,
          expenseAccountId: l.expenseAccountId ?? null,
          description: l.description,
          qty: new Prisma.Decimal(l.qty),
          unitCost: new Prisma.Decimal(l.unitCost),
          lineTotal: l.lineTotal,
          notes: l.notes ?? null,
        })),
      },
      receipts: {
        create: receiptIds.map((receiptId) => ({ receiptId })),
      },
      purchaseOrders: {
        create: purchaseOrderIds.map((purchaseOrderId) => ({ purchaseOrderId })),
      },
    },
    include: { lines: true, receipts: true, purchaseOrders: true },
  });

  await audit(tx, {
    action: options?.auditAction ?? AuditAction.CREATE,
    entityType: 'Bill',
    entityId: bill.id,
    after: bill,
    ctx,
  });

  return bill;
}

export async function createBill(
  db: PrismaClient,
  input: CreateBillInput,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  return db.$transaction((tx) => createBillTx(tx, input, ctx));
}

// ---------------------------------------------------------------------------
// updateBill — DRAFT-only, replace-all lines pattern
// ---------------------------------------------------------------------------

export async function updateBill(
  db: PrismaClient,
  billId: string,
  input: UpdateBillInput,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  const data = updateBillInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`;
    const before = await tx.bill.findUnique({
      where: { id: billId },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    if (!before) throw new Error(`Bill not found: ${billId}`);
    if (before.deletedAt) throw new Error('Bill is soft-deleted');
    if (before.status !== BillStatus.DRAFT) {
      throw new Error(
        `Cannot edit bill in status ${before.status} (only DRAFT is editable)`,
      );
    }

    const newFreight = data.freight != null
      ? new Prisma.Decimal(data.freight)
      : before.freight;
    const newTax = data.tax != null ? new Prisma.Decimal(data.tax) : before.tax;
    if (newFreight.greaterThan(0) || newTax.greaterThan(0)) {
      throw new Error(
        `Header freight/tax must be 0 in pilot scope (freight=${newFreight.toString()}, tax=${newTax.toString()}).`,
      );
    }

    const billDate = data.billDate ?? before.billDate;

    // Decide whether to replace lines.
    let nextSubtotal = before.subtotal;
    let derivedLines: Array<BillLineInput & { lineTotal: Prisma.Decimal }> | null = null;
    if (data.lines) {
      await validateLineRefsTx(tx, {
        vendorId: before.vendorId,
        source: before.source,
        lines: data.lines,
      });
      // Source-discriminator check: every line must match the bill's
      // existing source. Schema-level validation runs without knowledge
      // of bill.source on update; do the per-line check here.
      for (let i = 0; i < data.lines.length; i++) {
        const line = data.lines[i];
        if (before.source === BillSource.PRODUCT && line.expenseAccountId != null) {
          throw new Error(
            `Line ${i}: EXPENSE line not allowed on a PRODUCT bill`,
          );
        }
        if (before.source === BillSource.EXPENSE && line.variantId != null) {
          throw new Error(
            `Line ${i}: PRODUCT line not allowed on an EXPENSE bill`,
          );
        }
      }
      const computed = deriveLineTotals(data.lines);
      nextSubtotal = computed.subtotal;
      derivedLines = computed.lines;
    }

    const nextTotal = nextSubtotal.plus(newFreight).plus(newTax);

    if (derivedLines) {
      // Replace-all: hard-delete prior DRAFT lines (no FK dependents
      // exist for DRAFT bills) and create the new set. Replace receipt
      // and PO joins to match.
      await tx.billLine.deleteMany({ where: { billId } });
      await tx.billReceipt.deleteMany({ where: { billId } });
      await tx.billPurchaseOrder.deleteMany({ where: { billId } });

      const { receiptIds, purchaseOrderIds } = await deriveJoinedRefsTx(tx, {
        lines: derivedLines,
      });
      await tx.billLine.createMany({
        data: derivedLines.map((l, idx) => ({
          billId,
          lineNumber: idx + 1,
          variantId: l.variantId ?? null,
          receiptLineId: l.receiptLineId ?? null,
          expenseAccountId: l.expenseAccountId ?? null,
          description: l.description,
          qty: new Prisma.Decimal(l.qty),
          unitCost: new Prisma.Decimal(l.unitCost),
          lineTotal: l.lineTotal,
          notes: l.notes ?? null,
        })),
      });
      if (receiptIds.length > 0) {
        await tx.billReceipt.createMany({
          data: receiptIds.map((receiptId) => ({ billId, receiptId })),
        });
      }
      if (purchaseOrderIds.length > 0) {
        await tx.billPurchaseOrder.createMany({
          data: purchaseOrderIds.map((purchaseOrderId) => ({
            billId,
            purchaseOrderId,
          })),
        });
      }
    }

    const after = await tx.bill.update({
      where: { id: billId },
      data: {
        vendorReference:
          data.vendorReference !== undefined
            ? data.vendorReference
            : before.vendorReference,
        billDate,
        currency: data.currency ?? before.currency ?? 'USD',
        freight: newFreight,
        tax: newTax,
        subtotal: nextSubtotal,
        total: nextTotal,
        notes: data.notes !== undefined ? data.notes : before.notes,
      },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Bill',
      entityId: billId,
      before,
      after,
      ctx,
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// confirmBill — posts JE: DR Accrued Receipts (PRODUCT) or DR <expense>
//                         (EXPENSE) / CR AP. Sets dueDate + confirmedAt.
// ---------------------------------------------------------------------------

export async function confirmBillTx(
  tx: Prisma.TransactionClient,
  billId: string,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`;
  const before = await tx.bill.findUnique({
    where: { id: billId },
    include: {
      lines: true,
      receipts: true,
      purchaseOrders: true,
      vendor: { select: { paymentTermId: true } },
    },
  });
  if (!before) throw new Error(`Bill not found: ${billId}`);
  if (before.deletedAt) throw new Error('Bill is soft-deleted');
  if (before.status !== BillStatus.DRAFT) {
    throw new Error(
      `Cannot confirm bill in status ${before.status} (only DRAFT can be confirmed)`,
    );
  }
  if (before.lines.length === 0) {
    throw new Error('Cannot confirm a bill with no lines');
  }

  // Cross-record math sanity: SUM(line.lineTotal) === subtotal.
  const lineSum = before.lines.reduce(
    (acc, l) => acc.plus(l.lineTotal),
    new Prisma.Decimal(0),
  );
  if (lineSum.minus(before.subtotal).abs().greaterThan(LINE_MATH_TOLERANCE)) {
    throw new Error(
      `Bill ${before.number} line totals $${lineSum.toString()} don't match subtotal $${before.subtotal.toString()}`,
    );
  }

  // Compute dueDate from vendor's payment term (if any).
  let netDays: number | null = null;
  if (before.vendor.paymentTermId) {
    const term = await tx.paymentTerm.findUnique({
      where: { id: before.vendor.paymentTermId },
      select: { netDays: true },
    });
    netDays = term?.netDays ?? null;
  }
  const dueDate = computeDueDate(before.billDate, netDays);

  // Build JE.
  //   PRODUCT: DR 2020 Accrued Receipts (subtotal) / CR 2010 AP (subtotal).
  //            The receipt-time JE already DR'd Inventory / CR'd 2020;
  //            this confirm clears 2020 and books the AP.
  //   EXPENSE: DR each line's expenseAccount (lineTotal) / CR 2010 AP (subtotal).
  //            No prior receipt-time JE exists for expense bills — this
  //            is the first time these costs hit the GL.
  //
  // Pilot scope: total === subtotal (freight=tax=0 is enforced by
  // create/update). When freight/tax move to non-zero in a future slice,
  // CR 2010 will be `total` and there'll be additional DR legs for
  // freight/tax.
  const jeLines: Array<{
    accountCode: string;
    debit?: Prisma.Decimal;
    credit?: Prisma.Decimal;
    memo?: string;
  }> = [];
  if (before.source === BillSource.PRODUCT) {
    if (before.subtotal.greaterThan(0)) {
      jeLines.push({
        accountCode: ACCRUED_RECEIPTS_ACCOUNT,
        debit: before.subtotal,
        memo: `Clear accrued receipts for bill ${before.number}`,
      });
      jeLines.push({
        accountCode: AP_ACCOUNT,
        credit: before.subtotal,
        memo: `AP — vendor invoice ${before.vendorReference ?? before.number}`,
      });
    }
  } else {
    // EXPENSE — one DR per distinct expense account, sum-grouped to keep
    // the JE compact when multiple lines share an account.
    const byAccount = new Map<string, Prisma.Decimal>();
    for (const line of before.lines) {
      if (!line.expenseAccountId) {
        throw new Error(
          `Bill ${before.number} line ${line.lineNumber}: missing expenseAccountId on EXPENSE bill`,
        );
      }
      const cur = byAccount.get(line.expenseAccountId) ?? new Prisma.Decimal(0);
      byAccount.set(line.expenseAccountId, cur.plus(line.lineTotal));
    }
    // Resolve account ids → codes for the post() helper (which looks up by code).
    const accountIds = Array.from(byAccount.keys());
    const accounts = await tx.glAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true },
    });
    const idToCode = new Map(accounts.map((a) => [a.id, a.code]));
    for (const [accountId, amount] of byAccount.entries()) {
      const code = idToCode.get(accountId);
      if (!code) {
        throw new Error(`GlAccount lookup failed for id ${accountId}`);
      }
      if (amount.greaterThan(0)) {
        jeLines.push({
          accountCode: code,
          debit: amount,
          memo: `Expense ${code} — bill ${before.number}`,
        });
      }
    }
    if (before.subtotal.greaterThan(0)) {
      jeLines.push({
        accountCode: AP_ACCOUNT,
        credit: before.subtotal,
        memo: `AP — vendor invoice ${before.vendorReference ?? before.number}`,
      });
    }
  }

  if (jeLines.length > 0) {
    await post(tx, {
      entityType: 'Bill',
      entityId: before.id,
      description: `Confirm bill ${before.number}`,
      postedAt: before.billDate,
      lines: jeLines,
    });
  }

  const after = await tx.bill.update({
    where: { id: billId },
    data: {
      status: BillStatus.CONFIRMED,
      confirmedAt: new Date(),
      dueDate,
    },
    include: { lines: true, receipts: true, purchaseOrders: true },
  });

  await audit(tx, {
    action: AuditAction.BILL_CONFIRMED,
    entityType: 'Bill',
    entityId: billId,
    before: { status: before.status },
    after: { status: after.status, confirmedAt: after.confirmedAt, dueDate: after.dueDate },
    ctx,
  });

  return after;
}

export async function confirmBill(
  db: PrismaClient,
  billId: string,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  return db.$transaction((tx) => confirmBillTx(tx, billId, ctx));
}

// ---------------------------------------------------------------------------
// cancelBill — DRAFT: status flip only. CONFIRMED: refuse if any
//              payments/credits applied; else post offsetting JE.
// ---------------------------------------------------------------------------

export async function cancelBill(
  db: PrismaClient,
  billId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('cancelBill requires a non-empty reason');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`;
    const before = await tx.bill.findUnique({
      where: { id: billId },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    if (!before) throw new Error(`Bill not found: ${billId}`);
    if (before.deletedAt) throw new Error('Bill is soft-deleted');
    if (before.status === BillStatus.CANCELLED) {
      throw new Error('Bill is already CANCELLED');
    }

    if (before.status === BillStatus.DRAFT) {
      const after = await tx.bill.update({
        where: { id: billId },
        data: {
          status: BillStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
        include: { lines: true, receipts: true, purchaseOrders: true },
      });
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'Bill',
        entityId: billId,
        before: { status: before.status },
        after: { status: after.status },
        ctx: { ...ctx, reason },
      });
      return after;
    }

    // CONFIRMED → CANCELLED: refuse if any payments/credits attached.
    if (
      before.amountPaid.greaterThan(0) ||
      before.amountCredited.greaterThan(0)
    ) {
      throw new Error(
        'Cannot cancel a confirmed bill with applied payments or credits. Reverse those first, then cancel.',
      );
    }

    // Post the offsetting JE — debit/credit swap of the confirmation
    // legs. Source-aware mirror of confirmBillTx's posting block.
    const reverseLines: Array<{
      accountCode: string;
      debit?: Prisma.Decimal;
      credit?: Prisma.Decimal;
      memo?: string;
    }> = [];
    if (before.source === BillSource.PRODUCT) {
      if (before.subtotal.greaterThan(0)) {
        reverseLines.push({
          accountCode: ACCRUED_RECEIPTS_ACCOUNT,
          credit: before.subtotal,
          memo: `Reverse accrued-receipts clear (cancel bill ${before.number})`,
        });
        reverseLines.push({
          accountCode: AP_ACCOUNT,
          debit: before.subtotal,
          memo: `Reverse AP (cancel bill ${before.number})`,
        });
      }
    } else {
      const byAccount = new Map<string, Prisma.Decimal>();
      for (const line of before.lines) {
        if (!line.expenseAccountId) continue;
        const cur = byAccount.get(line.expenseAccountId) ?? new Prisma.Decimal(0);
        byAccount.set(line.expenseAccountId, cur.plus(line.lineTotal));
      }
      const accountIds = Array.from(byAccount.keys());
      const accounts = await tx.glAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, code: true },
      });
      const idToCode = new Map(accounts.map((a) => [a.id, a.code]));
      for (const [accountId, amount] of byAccount.entries()) {
        const code = idToCode.get(accountId);
        if (!code) continue;
        if (amount.greaterThan(0)) {
          reverseLines.push({
            accountCode: code,
            credit: amount,
            memo: `Reverse expense ${code} (cancel bill ${before.number})`,
          });
        }
      }
      if (before.subtotal.greaterThan(0)) {
        reverseLines.push({
          accountCode: AP_ACCOUNT,
          debit: before.subtotal,
          memo: `Reverse AP (cancel bill ${before.number})`,
        });
      }
    }

    if (reverseLines.length > 0) {
      await post(tx, {
        entityType: 'Bill',
        entityId: billId,
        description: `Cancel bill ${before.number}: ${reason}`,
        lines: reverseLines,
      });
    }

    const after = await tx.bill.update({
      where: { id: billId },
      data: {
        status: BillStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason,
      },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'Bill',
      entityId: billId,
      before: { status: before.status },
      after: { status: after.status, cancelledAt: after.cancelledAt },
      ctx: { ...ctx, reason },
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getBill(
  db: PrismaClient,
  billId: string,
): Promise<BillWithLines | null> {
  return db.bill.findFirst({
    where: { id: billId, deletedAt: null },
    include: {
      lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
      receipts: true,
      purchaseOrders: true,
    },
  });
}

export type BillListFilters = {
  vendorId?: string;
  status?: BillStatus | BillStatus[];
  paymentStatus?: BillPaymentStatus | BillPaymentStatus[];
  source?: BillSource;
  billDateFrom?: Date;
  billDateTo?: Date;
  q?: string;
  skip?: number;
  take?: number;
};

function billWhere(
  filters: Omit<BillListFilters, 'skip' | 'take'>,
): Prisma.BillWhereInput {
  const { vendorId, status, paymentStatus, source, billDateFrom, billDateTo, q } =
    filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (billDateFrom) dateFilter.gte = billDateFrom;
  if (billDateTo) dateFilter.lte = billDateTo;
  return {
    deletedAt: null,
    ...(vendorId ? { vendorId } : {}),
    ...(status
      ? { status: Array.isArray(status) ? { in: status } : status }
      : {}),
    ...(paymentStatus
      ? {
          paymentStatus: Array.isArray(paymentStatus)
            ? { in: paymentStatus }
            : paymentStatus,
        }
      : {}),
    ...(source ? { source } : {}),
    ...(billDateFrom || billDateTo ? { billDate: dateFilter } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: 'insensitive' as const } },
            { vendorReference: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

export async function listBills(
  db: PrismaClient,
  filters: BillListFilters = {},
): Promise<BillWithLines[]> {
  const { skip = 0, take = 100, ...rest } = filters;
  return db.bill.findMany({
    where: billWhere(rest),
    include: {
      lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
      receipts: true,
      purchaseOrders: true,
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

/**
 * Paginated variant. Returns `{ rows, total }` with the bill's vendor
 * (id, code, name) eager-loaded so the list table can render the vendor
 * column in a single round-trip. Same filter semantics as listBills.
 */
export async function listBillsPaged(
  db: PrismaClient,
  filters: BillListFilters = {},
): Promise<{
  rows: Array<
    Bill & {
      lines: BillLine[];
      vendor: { id: string; code: string; name: string };
    }
  >;
  total: number;
}> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = billWhere(rest);
  const [rows, total] = await Promise.all([
    db.bill.findMany({
      where,
      include: {
        lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
        vendor: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(take, 500),
    }),
    db.bill.count({ where }),
  ]);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// softDeleteBill — soft-delete (DRAFT only). Mirrors the AR-side rule
// that confirmed/voided records are append-only.
// ---------------------------------------------------------------------------

export async function softDeleteBill(
  db: PrismaClient,
  billId: string,
  ctx?: AuditContext,
): Promise<BillWithLines> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`;
    const before = await tx.bill.findUnique({
      where: { id: billId },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    if (!before) throw new Error(`Bill not found: ${billId}`);
    if (before.deletedAt) throw new Error('Bill is already soft-deleted');
    if (before.status !== BillStatus.DRAFT) {
      throw new Error(
        `Cannot soft-delete bill in status ${before.status} (only DRAFT). Cancel CONFIRMED bills instead.`,
      );
    }
    const after = await tx.bill.update({
      where: { id: billId },
      data: { deletedAt: new Date() },
      include: { lines: true, receipts: true, purchaseOrders: true },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'Bill',
      entityId: billId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// recomputeBillDenorms — self-heal Bill.amountPaid + amountCredited +
// paymentStatus from authoritative source rows.
//
// amountPaid       = SUM(BillPayment.amount WHERE status=RECORDED)
// amountCredited   = SUM(VendorCreditApplication.amount WHERE reversedAt IS NULL)
// paymentStatus    = derived from (amountPaid + amountCredited) vs total
//
// Mirrors recomputeAmountPaidForInvoice on the AR side. Service-internal
// helper — direct mutation of these fields by other paths is forbidden.
// ---------------------------------------------------------------------------

export async function recomputeBillDenormsTx(
  tx: Prisma.TransactionClient,
  billId: string,
): Promise<void> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: { id: true, total: true, status: true },
  });
  if (!bill) return;

  const [paymentAgg, creditAgg] = await Promise.all([
    tx.billPayment.aggregate({
      where: { billId, status: 'RECORDED' },
      _sum: { amount: true },
    }),
    tx.vendorCreditApplication.aggregate({
      where: { billId, reversedAt: null },
      _sum: { amount: true },
    }),
  ]);

  const amountPaid = paymentAgg._sum.amount ?? new Prisma.Decimal(0);
  // Cap amountPaid at bill.total — overpayments flow into a vendor
  // credit, NOT into a denorm value > total. Keeps the paymentStatus
  // derivation monotonic (PAID can't be silently breached by an
  // overpayment that should have triggered VC creation).
  const cappedPaid = amountPaid.greaterThan(bill.total) ? bill.total : amountPaid;
  const amountCredited = creditAgg._sum.amount ?? new Prisma.Decimal(0);

  const settled = cappedPaid.plus(amountCredited);
  let paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' = 'UNPAID';
  // Only CONFIRMED bills can transition past UNPAID — DRAFT bills
  // shouldn't accept payments anyway, but defending here keeps the
  // denorm honest if a future path bypasses validation.
  if (bill.status === 'CONFIRMED') {
    if (settled.greaterThanOrEqualTo(bill.total) && bill.total.greaterThan(0)) {
      paymentStatus = 'PAID';
    } else if (settled.greaterThan(0)) {
      paymentStatus = 'PARTIAL';
    }
  }

  await tx.bill.update({
    where: { id: billId },
    data: {
      amountPaid: cappedPaid,
      amountCredited,
      paymentStatus,
    },
  });
}

// ---------------------------------------------------------------------------
// createDraftBillFromReceiptTx — system-triggered hook called by
// postReceipt to auto-draft a bill matching the just-posted receipt.
// AP staff cross-references the vendor's actual invoice, edits +
// confirms (or cancels and starts over).
//
// Idempotency: skips when a non-cancelled bill already references this
// receipt — re-calling postReceipt (which currently can't happen because
// of the DRAFT-only status guard, but covers future re-posting paths)
// won't multi-create. Returns null on skip.
//
// Audit: writes DRAFT_BILL_GENERATED (not CREATE) so reports can filter
// system-triggered drafts apart from user-entered bills. Mirrors the
// INVOICE_GENERATED convention from invoices.ts.
// ---------------------------------------------------------------------------

export async function createDraftBillFromReceiptTx(
  tx: Prisma.TransactionClient,
  receiptId: string,
  ctx?: AuditContext,
): Promise<BillWithLines | null> {
  // Skip if a non-cancelled bill already references this receipt.
  // Includes DRAFT, CONFIRMED, and any future intermediate state — we
  // only re-create after explicit cancel.
  const existing = await tx.billReceipt.findFirst({
    where: {
      receiptId,
      bill: { status: { not: BillStatus.CANCELLED }, deletedAt: null },
    },
    select: { billId: true },
  });
  if (existing) return null;

  const receipt = await tx.receipt.findUnique({
    where: { id: receiptId },
    include: {
      lines: {
        where: { deletedAt: null },
        include: { variant: { select: { sku: true, name: true } } },
      },
    },
  });
  if (!receipt) throw new Error(`Receipt not found: ${receiptId}`);

  // Only positive-qty lines flow into the bill — zero-qty lines exist
  // on receipts in pathological cases but createBill validation
  // requires qty > 0 (positiveDecimal).
  const billLines = receipt.lines
    .filter((l) => l.qtyReceived.greaterThan(0))
    .map((l) => ({
      variantId: l.variantId,
      receiptLineId: l.id,
      description: l.variant.name ?? l.variant.sku,
      qty: l.qtyReceived.toString(),
      unitCost: l.unitCost.toString(),
    }));

  if (billLines.length === 0) return null;

  return createBillTx(
    tx,
    {
      vendorId: receipt.vendorId,
      source: BillSource.PRODUCT,
      notes: `Auto-drafted from receipt ${receipt.number}. Edit + confirm when vendor invoice arrives.`,
      lines: billLines,
    },
    ctx,
    { auditAction: AuditAction.DRAFT_BILL_GENERATED },
  );
}

// ---------------------------------------------------------------------------
// cancelDraftBillsForReceiptTx — system-triggered hook called by
// cancelReceipt to cascade-cancel any DRAFT bill that was auto-created
// (or manually linked) from the receipt being cancelled. CONFIRMED bills
// are NOT touched here — they're guarded against in cancelReceipt's
// pre-check, which throws upfront.
// ---------------------------------------------------------------------------

export async function cancelDraftBillsForReceiptTx(
  tx: Prisma.TransactionClient,
  receiptId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<string[]> {
  const links = await tx.billReceipt.findMany({
    where: {
      receiptId,
      bill: { status: BillStatus.DRAFT, deletedAt: null },
    },
    select: { billId: true },
  });
  const cancelledIds: string[] = [];
  const now = new Date();
  for (const link of links) {
    // DRAFT cancel is status-flip-only (no JE to reverse). Inline rather
    // than calling cancelBill (which would open a nested transaction).
    await tx.bill.update({
      where: { id: link.billId },
      data: {
        status: BillStatus.CANCELLED,
        cancelledAt: now,
        cancelReason: reason,
      },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'Bill',
      entityId: link.billId,
      before: { status: BillStatus.DRAFT },
      after: { status: BillStatus.CANCELLED },
      ctx: { ...ctx, reason },
    });
    cancelledIds.push(link.billId);
  }
  return cancelledIds;
}

// ---------------------------------------------------------------------------
// hasConfirmedBillForReceipt — guard helper for cancelReceipt to refuse
// when a confirmed bill links to the receipt. Returns the blocking
// bill's number for the error message, or null if clear to cancel.
// ---------------------------------------------------------------------------

export async function hasConfirmedBillForReceiptTx(
  tx: Prisma.TransactionClient,
  receiptId: string,
): Promise<{ billId: string; number: string } | null> {
  const link = await tx.billReceipt.findFirst({
    where: {
      receiptId,
      bill: { status: BillStatus.CONFIRMED, deletedAt: null },
    },
    select: { billId: true, bill: { select: { number: true } } },
  });
  if (!link) return null;
  return { billId: link.billId, number: link.bill.number };
}
