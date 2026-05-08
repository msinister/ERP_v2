import {
  AuditAction,
  BillPaymentStatus,
  BillStatus,
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ReceiptStatus,
  VendorCreditStatus,
} from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// Reconciliation checks — slice D of phase 9. Spec docs/08:326-334.
//
// Five spec'd checks (INVENTORY fans out per warehouse):
//   AR_CONTROL          — GL 1210 vs sum(open invoice balances) − unapplied credits
//   AP_CONTROL          — GL 2010 vs sum(open bill balances) − unapplied VCs − overpayment-VC originals
//   INVENTORY_<wh-code> — GL <wh inventory account> vs sum FIFO layer values per warehouse
//   CASH                — GL 1110 vs sum(customer payments) − sum(bill payments to 1110)
//   ACCRUED_RECEIPTS    — GL 2020 vs 0 (any non-zero balance flagged)
//
// Each check returns a structured result with:
//   - glBalance (signed, positive = "natural posture")
//   - subledgerBalance (the value GL should equal if data is consistent)
//   - difference = glBalance − subledgerBalance
//   - passed = |difference| <= RECON_TOLERANCE
//   - details (JSON) — bucket-level numbers for operator investigation
//
// The "subledgerBalance" formula for AP includes a correction for the
// overpayment-VC double-DR quirk on AP (see slice D commit notes for
// the full derivation). Net invariant:
//   GL_AP === sum(open bills) − sum(unapplied VCs) − sum(overpayment-VC.amount)
//
// runAllReconChecksTx orchestrates all 5 (well, 4 + N inventory), persists
// each as a PeriodReconciliationCheck row, and writes a single
// RECONCILIATION_RUN audit row tied to the period.
//
// Date semantics: glBalance uses cumulative-through-period.endDate
// (postedAt < endDate). Subledger queries are "live" at check time —
// if material activity has occurred between period.endDate and the
// check, it may show as a discrepancy. For pilot scope, recon is
// expected to run shortly after period end.
// =============================================================================

const RECON_TOLERANCE = new Prisma.Decimal('0.001');

const AR_ACCOUNT = '1210';
const AP_ACCOUNT = '2010';
const CASH_ACCOUNT = '1110';
const ACCRUED_RECEIPTS_ACCOUNT = '2020';

const ZERO = new Prisma.Decimal(0);

export type ReconCheckResult = {
  checkType: string;
  glBalance: Prisma.Decimal;
  subledgerBalance: Prisma.Decimal;
  difference: Prisma.Decimal;
  passed: boolean;
  details: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// AR_CONTROL
// ---------------------------------------------------------------------------

async function arControlCheckTx(
  tx: Prisma.TransactionClient,
  asOf: Date,
): Promise<ReconCheckResult> {
  const account = await tx.glAccount.findFirst({
    where: { code: AR_ACCOUNT, deletedAt: null },
    select: { id: true },
  });
  if (!account) {
    throw new Error(`AR control account ${AR_ACCOUNT} not found or soft-deleted`);
  }

  const glAgg = await tx.journalEntryLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { postedAt: { lt: asOf }, deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  // AR is ASSET (natural Dr balance). Positive glBalance = "we are owed."
  const glBalance = (glAgg._sum.debit ?? ZERO).minus(glAgg._sum.credit ?? ZERO);

  const openInvoices = await tx.invoice.findMany({
    where: {
      deletedAt: null,
      status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIAL] },
    },
    select: { total: true, amountPaid: true, amountCredited: true },
  });
  const openInvoicesTotal = openInvoices.reduce(
    (acc, i) => acc.plus(i.total).minus(i.amountPaid).minus(i.amountCredited),
    ZERO,
  );

  // Unapplied CMs: amount issued but not yet applied to a specific invoice.
  // Per AR-side spec, CM confirm posts CR 1210 for full netCredit, so
  // unapplied portion sits as "GL reduced by an amount the subledger
  // doesn't yet attribute to a specific invoice."
  const cms = await tx.creditMemo.findMany({
    where: { deletedAt: null, status: CreditMemoStatus.CONFIRMED },
    select: { netCredit: true, appliedAmount: true },
  });
  const unappliedCMs = cms.reduce(
    (acc, c) => acc.plus(c.netCredit).minus(c.appliedAmount),
    ZERO,
  );

  // Unapplied non-APPLIED_CREDIT payments: customer paid more than was
  // applied to invoices (e.g., advance payment).
  const pmts = await tx.payment.findMany({
    where: {
      deletedAt: null,
      status: PaymentStatus.RECORDED,
      method: { not: PaymentMethod.APPLIED_CREDIT },
    },
    select: { amount: true, appliedAmount: true },
  });
  const unappliedPayments = pmts.reduce(
    (acc, p) => acc.plus(p.amount).minus(p.appliedAmount),
    ZERO,
  );

  // The GL-equivalent subledger value: open invoices reduced by both
  // forms of unapplied credit. If books are sound, this matches GL_AR.
  const subledgerBalance = openInvoicesTotal
    .minus(unappliedCMs)
    .minus(unappliedPayments);
  const difference = glBalance.minus(subledgerBalance);

  return {
    checkType: 'AR_CONTROL',
    glBalance,
    subledgerBalance,
    difference,
    passed: difference.abs().lessThanOrEqualTo(RECON_TOLERANCE),
    details: {
      openInvoiceBalance: openInvoicesTotal.toString(),
      openInvoiceCount: openInvoices.length,
      unappliedCreditMemos: unappliedCMs.toString(),
      unappliedPayments: unappliedPayments.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// AP_CONTROL
// ---------------------------------------------------------------------------

async function apControlCheckTx(
  tx: Prisma.TransactionClient,
  asOf: Date,
): Promise<ReconCheckResult> {
  const account = await tx.glAccount.findFirst({
    where: { code: AP_ACCOUNT, deletedAt: null },
    select: { id: true },
  });
  if (!account) {
    throw new Error(`AP control account ${AP_ACCOUNT} not found or soft-deleted`);
  }

  const glAgg = await tx.journalEntryLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { postedAt: { lt: asOf }, deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  // AP is LIABILITY (natural Cr balance). Positive glBalance = "we owe."
  // For AP, glBalance can go negative when overpayments have over-DR'd
  // the account (see derivation in file header).
  const glBalance = (glAgg._sum.credit ?? ZERO).minus(glAgg._sum.debit ?? ZERO);

  const openBills = await tx.bill.findMany({
    where: {
      deletedAt: null,
      status: BillStatus.CONFIRMED,
      paymentStatus: {
        in: [BillPaymentStatus.UNPAID, BillPaymentStatus.PARTIAL],
      },
    },
    select: { total: true, amountPaid: true, amountCredited: true },
  });
  const openBillsTotal = openBills.reduce(
    (acc, b) => acc.plus(b.total).minus(b.amountPaid).minus(b.amountCredited),
    ZERO,
  );

  const vcs = await tx.vendorCredit.findMany({
    where: { deletedAt: null, status: VendorCreditStatus.CONFIRMED },
    select: { amount: true, appliedAmount: true, sourceTag: true },
  });
  const unappliedVCs = vcs.reduce(
    (acc, v) => acc.plus(v.amount).minus(v.appliedAmount),
    ZERO,
  );
  // Overpayment auto-VCs caused a double-DR on AP at create time (the
  // BillPayment DR'd full payment amount; the auto-VC then DR'd AP for
  // the overpayment portion). The recon equation includes their
  // ORIGINAL amount (not their unapplied portion) as a correction term.
  const overpaymentVCAmount = vcs
    .filter((v) => v.sourceTag?.startsWith('OVERPAYMENT:'))
    .reduce((acc, v) => acc.plus(v.amount), ZERO);

  // Per the derivation in the file header:
  //   GL_AP === sum(open bills) − sum(unapplied VCs) − sum(overpayment-VC.amount)
  const subledgerBalance = openBillsTotal
    .minus(unappliedVCs)
    .minus(overpaymentVCAmount);
  const difference = glBalance.minus(subledgerBalance);

  return {
    checkType: 'AP_CONTROL',
    glBalance,
    subledgerBalance,
    difference,
    passed: difference.abs().lessThanOrEqualTo(RECON_TOLERANCE),
    details: {
      openBillBalance: openBillsTotal.toString(),
      openBillCount: openBills.length,
      unappliedVendorCredits: unappliedVCs.toString(),
      overpaymentVcOriginalAmount: overpaymentVCAmount.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// INVENTORY (per warehouse, fan-out)
// ---------------------------------------------------------------------------

async function inventoryChecksTx(
  tx: Prisma.TransactionClient,
  asOf: Date,
): Promise<ReconCheckResult[]> {
  const warehouses = await tx.warehouse.findMany({
    where: {
      deletedAt: null,
      inventoryAccountId: { not: null },
    },
    select: {
      id: true,
      code: true,
      inventoryAccount: { select: { id: true, code: true } },
    },
  });

  const results: ReconCheckResult[] = [];
  for (const wh of warehouses) {
    if (!wh.inventoryAccount) continue;

    const glAgg = await tx.journalEntryLine.aggregate({
      where: {
        accountId: wh.inventoryAccount.id,
        journalEntry: { postedAt: { lt: asOf }, deletedAt: null },
      },
      _sum: { debit: true, credit: true },
    });
    // Inventory is ASSET. Natural Dr balance.
    const glBalance = (glAgg._sum.debit ?? ZERO).minus(
      glAgg._sum.credit ?? ZERO,
    );

    // Subledger: SUM(qtyRemaining × unitCost) for non-deleted layers.
    // qtyRemaining is a CHECK-constrained denorm of qtyReceived − qtyConsumed,
    // maintained by the FIFO consumption service.
    const layers = await tx.fifoLayer.findMany({
      where: { warehouseId: wh.id, deletedAt: null },
      select: { qtyRemaining: true, unitCost: true },
    });
    const subledgerBalance = layers.reduce(
      (acc, l) => acc.plus(l.qtyRemaining.times(l.unitCost)),
      ZERO,
    );

    const difference = glBalance.minus(subledgerBalance);

    results.push({
      checkType: `INVENTORY_${wh.code}`,
      glBalance,
      subledgerBalance,
      difference,
      passed: difference.abs().lessThanOrEqualTo(RECON_TOLERANCE),
      details: {
        warehouseId: wh.id,
        warehouseCode: wh.code,
        inventoryAccountCode: wh.inventoryAccount.code,
        layerCount: layers.length,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CASH
// ---------------------------------------------------------------------------

async function cashControlCheckTx(
  tx: Prisma.TransactionClient,
  asOf: Date,
): Promise<ReconCheckResult> {
  const account = await tx.glAccount.findFirst({
    where: { code: CASH_ACCOUNT, deletedAt: null },
    select: { id: true },
  });
  if (!account) {
    throw new Error(`Cash account ${CASH_ACCOUNT} not found or soft-deleted`);
  }

  const glAgg = await tx.journalEntryLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { postedAt: { lt: asOf }, deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  // Cash is ASSET. Natural Dr.
  const glBalance = (glAgg._sum.debit ?? ZERO).minus(glAgg._sum.credit ?? ZERO);

  // Customer Payments DR Cash 1110 (hardcoded in payments.ts).
  // Exclude APPLIED_CREDIT method (no cash flow) and REVERSED status
  // (offsetting JEs already net to zero in GL).
  const customerPmtAgg = await tx.payment.aggregate({
    where: {
      deletedAt: null,
      status: PaymentStatus.RECORDED,
      method: { not: PaymentMethod.APPLIED_CREDIT },
    },
    _sum: { amount: true },
  });
  const customerPmtTotal = customerPmtAgg._sum.amount ?? ZERO;

  // Bill payments may target any cash account. We only count the ones
  // that hit 1110 against the 1110 GL.
  const billPmtAgg = await tx.billPayment.aggregate({
    where: {
      deletedAt: null,
      status: PaymentStatus.RECORDED,
      cashAccountId: account.id,
    },
    _sum: { amount: true },
  });
  const billPmtTotal = billPmtAgg._sum.amount ?? ZERO;

  const subledgerBalance = customerPmtTotal.minus(billPmtTotal);
  const difference = glBalance.minus(subledgerBalance);

  return {
    checkType: 'CASH',
    glBalance,
    subledgerBalance,
    difference,
    passed: difference.abs().lessThanOrEqualTo(RECON_TOLERANCE),
    details: {
      cashAccountCode: CASH_ACCOUNT,
      customerPaymentsTotal: customerPmtTotal.toString(),
      billPaymentsToCashTotal: billPmtTotal.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// ACCRUED_RECEIPTS
// ---------------------------------------------------------------------------

async function accruedReceiptsCheckTx(
  tx: Prisma.TransactionClient,
  asOf: Date,
): Promise<ReconCheckResult> {
  const account = await tx.glAccount.findFirst({
    where: { code: ACCRUED_RECEIPTS_ACCOUNT, deletedAt: null },
    select: { id: true },
  });
  if (!account) {
    throw new Error(
      `Accrued Receipts account ${ACCRUED_RECEIPTS_ACCOUNT} not found or soft-deleted`,
    );
  }

  const glAgg = await tx.journalEntryLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { postedAt: { lt: asOf }, deletedAt: null },
    },
    _sum: { debit: true, credit: true },
  });
  // 2020 is LIABILITY (natural Cr). Expected: zero (every receipt should
  // be billed; bill confirm clears the accrued amount).
  const glBalance = (glAgg._sum.credit ?? ZERO).minus(glAgg._sum.debit ?? ZERO);
  const subledgerBalance = ZERO;
  const difference = glBalance.minus(subledgerBalance);

  // Surface unbilled posted receipts as informational details — these
  // are the most likely cause of a non-zero accrued receipts balance.
  // Limit to first 20 for response size; details can be drilled into via
  // the receipts API if there are more.
  const unbilledReceipts = await tx.receipt.findMany({
    where: {
      status: ReceiptStatus.POSTED,
      deletedAt: null,
      NOT: {
        billLinks: {
          some: {
            bill: { status: BillStatus.CONFIRMED, deletedAt: null },
          },
        },
      },
    },
    select: { id: true, number: true, receivedAt: true, vendorId: true },
    take: 20,
    orderBy: { receivedAt: 'asc' },
  });

  return {
    checkType: 'ACCRUED_RECEIPTS',
    glBalance,
    subledgerBalance,
    difference,
    passed: difference.abs().lessThanOrEqualTo(RECON_TOLERANCE),
    details: {
      unbilledReceiptCount: unbilledReceipts.length,
      unbilledReceiptsSample: unbilledReceipts.map((r) => ({
        id: r.id,
        number: r.number,
        receivedAt: r.receivedAt?.toISOString() ?? null,
        vendorId: r.vendorId,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// runAllReconChecksTx — orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all 5 (well, 4 + N inventory) recon checks, persist each as a
 * PeriodReconciliationCheck row, write a RECONCILIATION_RUN audit row.
 * Returns the array of results (in canonical order: AR, AP, INVENTORY*, CASH, ACCRUED_RECEIPTS).
 *
 * Tx-internal — Prisma transactions don't safely support concurrent
 * operations, so checks run sequentially.
 */
export async function runAllReconChecksTx(
  tx: Prisma.TransactionClient,
  fiscalPeriodId: string,
  ctx?: AuditContext,
): Promise<ReconCheckResult[]> {
  const period = await tx.fiscalPeriod.findUnique({
    where: { id: fiscalPeriodId },
  });
  if (!period) {
    throw new Error(`FiscalPeriod not found: ${fiscalPeriodId}`);
  }
  const asOf = period.endDate;

  const arResult = await arControlCheckTx(tx, asOf);
  const apResult = await apControlCheckTx(tx, asOf);
  const inventoryResults = await inventoryChecksTx(tx, asOf);
  const cashResult = await cashControlCheckTx(tx, asOf);
  const accruedResult = await accruedReceiptsCheckTx(tx, asOf);

  const allResults = [
    arResult,
    apResult,
    ...inventoryResults,
    cashResult,
    accruedResult,
  ];

  for (const r of allResults) {
    await tx.periodReconciliationCheck.create({
      data: {
        fiscalPeriodId,
        checkType: r.checkType,
        glBalance: r.glBalance,
        subledgerBalance: r.subledgerBalance,
        difference: r.difference,
        passed: r.passed,
        details: (r.details as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  }

  await audit(tx, {
    action: AuditAction.RECONCILIATION_RUN,
    entityType: 'FiscalPeriod',
    entityId: fiscalPeriodId,
    after: {
      asOf: asOf.toISOString(),
      checkCount: allResults.length,
      passedCount: allResults.filter((r) => r.passed).length,
      failedCount: allResults.filter((r) => !r.passed).length,
    },
    ctx,
  });

  return allResults;
}

export async function runAllReconChecks(
  db: PrismaClient,
  fiscalPeriodId: string,
  ctx?: AuditContext,
): Promise<ReconCheckResult[]> {
  return db.$transaction((tx) =>
    runAllReconChecksTx(tx, fiscalPeriodId, ctx),
  );
}

// ---------------------------------------------------------------------------
// listReconChecks — read latest persisted snapshots for a period
// ---------------------------------------------------------------------------

export async function listReconChecksForPeriod(
  db: PrismaClient,
  fiscalPeriodId: string,
  opts: { latestPerCheckType?: boolean } = {},
): Promise<
  Array<{
    id: string;
    checkType: string;
    glBalance: Prisma.Decimal;
    subledgerBalance: Prisma.Decimal;
    difference: Prisma.Decimal;
    passed: boolean;
    details: unknown;
    checkedAt: Date;
  }>
> {
  const all = await db.periodReconciliationCheck.findMany({
    where: { fiscalPeriodId },
    orderBy: [{ checkType: 'asc' }, { checkedAt: 'desc' }],
  });

  if (!opts.latestPerCheckType) return all;

  // Keep only the most recent row per checkType (the orderBy sets
  // checkedAt desc within each type so the first occurrence wins).
  const seen = new Set<string>();
  const out: typeof all = [];
  for (const row of all) {
    if (seen.has(row.checkType)) continue;
    seen.add(row.checkType);
    out.push(row);
  }
  return out;
}
