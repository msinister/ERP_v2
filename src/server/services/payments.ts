import {
  AccountType,
  AuditAction,
  CreditApplicationKind,
  CreditMemoStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@/generated/tenant';
import type {
  CreditApplication,
  Payment,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  applyCreditInputSchema,
  recordPaymentInputSchema,
  reversePaymentInputSchema,
  type ApplyCreditInput,
  type RecordPaymentInput,
  type ReversePaymentInput,
} from '@/lib/validation/invoicing';
import { recomputeAmountPaidForInvoice } from './invoices';
import {
  accrueCommissionForApplicationTx,
  reverseCommissionForPaymentTx,
} from './commission';

// =============================================================================
// Payments service.
//
// recordPayment is the canonical entry point for receiving customer money.
// applyPaymentToInvoice / applyCreditToInvoice are the discrete one-line
// applications. reversePayment undoes a recorded payment.
//
// JE creation goes through lib/gl/post — never tx.journalEntry.create.
// Direct mutation of Invoice.amountPaid / amountCredited is forbidden;
// every mutation routes through invoices.recomputeAmountPaidForInvoice.
//
// IMPORTANT — APPLIED_CREDIT method semantics: a recordPayment with
// method=APPLIED_CREDIT does NOT post a cash-receipt JE. Cash didn't
// move; the customer is consuming existing CreditMemo credit. The
// Payment row exists for audit trail. Each application entry is
// internally implemented as a CreditApplication of
// kind=CREDIT_TO_INVOICE drawn FIFO from the customer's confirmed
// CMs (oldest first), bumping CM.appliedAmount and the invoice's
// amountCredited (NOT amountPaid). Documented inline below.
// =============================================================================

const PAYMENT_SEQUENCE_NAME = 'payment';
const PAYMENT_PREFIX = 'PMT';
const CASH_ACCOUNT = '1110';
const AR_ACCOUNT = '1210';

export type PaymentWithApplications = Payment & { applications: CreditApplication[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function lockPayment(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
}

async function lockCreditMemo(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "CreditMemo" WHERE "id" = ${creditMemoId} FOR UPDATE`;
}

/**
 * Customer's available CreditMemo credit at this moment — sum of
 * (CM.netCredit − CM.appliedAmount) over CONFIRMED, non-voided,
 * non-deleted CMs. Used by APPLIED_CREDIT validation.
 */
async function getAvailableCmCredit(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<Prisma.Decimal> {
  const cms = await tx.creditMemo.findMany({
    where: {
      customerId,
      status: CreditMemoStatus.CONFIRMED,
      deletedAt: null,
    },
    select: { netCredit: true, appliedAmount: true },
  });
  return cms.reduce(
    (acc, c) => acc.plus(c.netCredit).minus(c.appliedAmount),
    new Prisma.Decimal(0),
  );
}

// ---------------------------------------------------------------------------
// applyPaymentToInvoice (Tx variant + public wrapper)
// ---------------------------------------------------------------------------

async function applyPaymentToInvoiceTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  invoiceId: string,
  amount: Prisma.Decimal,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  await lockPayment(tx, paymentId);
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (payment.deletedAt) throw new Error('Payment is soft-deleted');
  if (payment.status !== PaymentStatus.RECORDED) {
    throw new Error(`Cannot apply payment in status ${payment.status}`);
  }

  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
  if (invoice.customerId !== payment.customerId) {
    throw new Error(
      `Cross-customer application: payment customer ${payment.customerId} != invoice customer ${invoice.customerId}`,
    );
  }
  if (invoice.status === InvoiceStatus.VOIDED) {
    throw new Error('Cannot apply payment to a VOIDED invoice');
  }

  // Don't overapply.
  const newApplied = payment.appliedAmount.plus(amount);
  if (newApplied.greaterThan(payment.amount)) {
    throw new Error(
      `Application would overapply payment ${payment.number}: applied=${payment.appliedAmount.toString()} + ${amount.toString()} > amount=${payment.amount.toString()}`,
    );
  }

  // Friendly precheck for the partial-unique invariant. The DB index
  // is the authoritative guard but the human-readable error here is
  // worth the extra query.
  const existing = await tx.creditApplication.findFirst({
    where: { paymentId, invoiceId, reversedAt: null },
  });
  if (existing) {
    throw new Error(
      `Payment ${payment.number} already partially applied to invoice ${invoice.number}. Reverse the existing application first if you need to adjust.`,
    );
  }

  const app = await tx.creditApplication.create({
    data: {
      kind: CreditApplicationKind.PAYMENT_TO_INVOICE,
      paymentId,
      invoiceId,
      amount,
      appliedById: ctx?.userId ?? null,
    },
  });

  await tx.payment.update({
    where: { id: paymentId },
    data: { appliedAmount: newApplied },
  });

  await recomputeAmountPaidForInvoice(tx, invoiceId);

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CreditApplication',
    entityId: app.id,
    after: app,
    ctx,
  });
  return app;
}

export async function applyPaymentToInvoice(
  db: PrismaClient,
  paymentId: string,
  invoiceId: string,
  amount: Prisma.Decimal | string | number,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  return db.$transaction((tx) =>
    applyPaymentToInvoiceTx(tx, paymentId, invoiceId, new Prisma.Decimal(amount), ctx),
  );
}

// ---------------------------------------------------------------------------
// unapplyPaymentFromInvoice
// ---------------------------------------------------------------------------

/**
 * Reverse a single PAYMENT_TO_INVOICE application: the money stays
 * received (the payment + its cash-receipt JE are untouched) but the
 * internal allocation to one invoice is undone. The application is
 * soft-reversed (reversedAt stamped, never hard-deleted, to preserve the
 * audit trail), the invoice's amountPaid/status are recomputed, and the
 * amount returns to the payment's unapplied balance.
 *
 * No JE and no commission change — this is the inverse of the standalone
 * applyPaymentToInvoice, which likewise touches neither (commission is
 * handled only at recordPayment / reversePayment granularity).
 *
 * Only direct payment applications are unappliable here. CREDIT_TO_INVOICE
 * rows (the APPLIED_CREDIT path) draw from a CreditMemo, not the payment's
 * own balance, and are rejected.
 */
export async function unapplyPaymentFromInvoice(
  db: PrismaClient,
  paymentId: string,
  applicationId: string,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  return db.$transaction(async (tx) => {
    await lockPayment(tx, paymentId);
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new Error(`Payment not found: ${paymentId}`);
    if (payment.deletedAt) throw new Error('Payment is soft-deleted');
    if (payment.status !== PaymentStatus.RECORDED) {
      throw new Error(
        `Cannot unapply from a payment in status ${payment.status}`,
      );
    }

    const app = await tx.creditApplication.findUnique({
      where: { id: applicationId },
    });
    if (!app) throw new Error(`Application not found: ${applicationId}`);
    if (app.paymentId !== paymentId) {
      throw new Error('Application does not belong to this payment');
    }
    if (app.kind !== CreditApplicationKind.PAYMENT_TO_INVOICE) {
      throw new Error(
        'Only direct payment applications can be unapplied (credit-funded applications draw from a credit memo)',
      );
    }
    if (app.reversedAt != null) {
      throw new Error('Application is already unapplied');
    }

    const invoice = await tx.invoice.findUnique({
      where: { id: app.invoiceId },
      select: { number: true },
    });

    const now = new Date();
    await tx.creditApplication.update({
      where: { id: app.id },
      data: { reversedAt: now },
    });

    // Return the amount to the payment's unapplied balance. Floor at 0
    // defensively against denorm drift.
    const newApplied = payment.appliedAmount.minus(app.amount);
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        appliedAmount: newApplied.lessThan(0)
          ? new Prisma.Decimal(0)
          : newApplied,
      },
    });

    // Recompute invoice amountPaid + status (PAID → PARTIAL / OPEN).
    await recomputeAmountPaidForInvoice(tx, app.invoiceId);

    const reason =
      ctx?.reason ??
      `Unapplied ${app.amount.toString()} from invoice ${invoice?.number ?? app.invoiceId}`;
    await audit(tx, {
      action: AuditAction.REVERSE,
      entityType: 'CreditApplication',
      entityId: app.id,
      before: { reversedAt: null },
      after: { reversedAt: now },
      ctx: { ...ctx, reason },
    });

    return tx.creditApplication.findUniqueOrThrow({ where: { id: app.id } });
  });
}

// ---------------------------------------------------------------------------
// applyCreditToInvoice (Tx variant + public wrapper)
// ---------------------------------------------------------------------------

async function applyCreditToInvoiceTx(
  tx: Prisma.TransactionClient,
  creditMemoId: string,
  invoiceId: string,
  amount: Prisma.Decimal,
  ctx?: AuditContext,
  // When set, the CreditApplication row carries BOTH creditMemoId
  // and paymentId — used by the APPLIED_CREDIT method on
  // recordPayment so reversePayment can find these rows via the
  // Payment.applications relation. kind stays CREDIT_TO_INVOICE so
  // recomputeAmountPaid bumps the invoice's amountCredited (not
  // amountPaid), per spec.
  applicationPaymentId?: string,
): Promise<CreditApplication> {
  await lockCreditMemo(tx, creditMemoId);
  const cm = await tx.creditMemo.findUnique({ where: { id: creditMemoId } });
  if (!cm) throw new Error(`CreditMemo not found: ${creditMemoId}`);
  if (cm.deletedAt) throw new Error('CreditMemo is soft-deleted');
  if (cm.status !== CreditMemoStatus.CONFIRMED) {
    throw new Error(`Cannot apply credit memo in status ${cm.status}`);
  }

  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  if (invoice.deletedAt) throw new Error('Invoice is soft-deleted');
  if (invoice.customerId !== cm.customerId) {
    throw new Error(
      `Cross-customer credit application: CM customer ${cm.customerId} != invoice customer ${invoice.customerId}`,
    );
  }
  if (invoice.status === InvoiceStatus.VOIDED) {
    throw new Error('Cannot apply credit to a VOIDED invoice');
  }

  const newApplied = cm.appliedAmount.plus(amount);
  if (newApplied.greaterThan(cm.netCredit)) {
    throw new Error(
      `Application would overapply credit memo ${cm.number}: applied=${cm.appliedAmount.toString()} + ${amount.toString()} > netCredit=${cm.netCredit.toString()}`,
    );
  }

  const existing = await tx.creditApplication.findFirst({
    where: { creditMemoId, invoiceId, reversedAt: null },
  });
  if (existing) {
    throw new Error(
      `Credit memo ${cm.number} already partially applied to invoice ${invoice.number}. Reverse the existing application first if you need to adjust.`,
    );
  }

  const app = await tx.creditApplication.create({
    data: {
      kind: CreditApplicationKind.CREDIT_TO_INVOICE,
      creditMemoId,
      // Optionally tied to a Payment row too (the APPLIED_CREDIT method
      // path) so the reverse path can find these rows via
      // Payment.applications. The partial unique index on
      // (paymentId, invoiceId) WHERE reversedAt IS NULL gracefully
      // permits this since we already pre-checked uniqueness above.
      paymentId: applicationPaymentId ?? null,
      invoiceId,
      amount,
      appliedById: ctx?.userId ?? null,
    },
  });

  await tx.creditMemo.update({
    where: { id: creditMemoId },
    data: { appliedAmount: newApplied },
  });

  await recomputeAmountPaidForInvoice(tx, invoiceId);

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'CreditApplication',
    entityId: app.id,
    after: app,
    ctx,
  });
  return app;
}

export async function applyCreditToInvoice(
  db: PrismaClient,
  input: ApplyCreditInput,
  ctx?: AuditContext,
): Promise<CreditApplication> {
  const data = applyCreditInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    if (data.paymentId) {
      return applyPaymentToInvoiceTx(
        tx,
        data.paymentId,
        data.invoiceId,
        new Prisma.Decimal(data.amount),
        ctx,
      );
    }
    return applyCreditToInvoiceTx(
      tx,
      data.creditMemoId!,
      data.invoiceId,
      new Prisma.Decimal(data.amount),
      ctx,
    );
  });
}

// ---------------------------------------------------------------------------
// FIFO consumption of CM credit for APPLIED_CREDIT-method payments
// ---------------------------------------------------------------------------

/**
 * Walk the customer's CONFIRMED non-voided CMs in confirmedAt-ascending
 * order, drawing down `requestedAmount` of credit and applying it to
 * the target invoice. Each CM hit produces its own CreditApplication
 * row of kind=CREDIT_TO_INVOICE linked to BOTH the CM and the
 * APPLIED_CREDIT Payment (so reversePayment can find these via
 * Payment.applications). Returns the applications created.
 */
async function applyFifoCmCreditTx(
  tx: Prisma.TransactionClient,
  customerId: string,
  invoiceId: string,
  requestedAmount: Prisma.Decimal,
  appliedCreditPaymentId: string,
  appliedCreditPaymentNumber: string,
  ctx?: AuditContext,
): Promise<CreditApplication[]> {
  const cms = await tx.creditMemo.findMany({
    where: {
      customerId,
      status: CreditMemoStatus.CONFIRMED,
      deletedAt: null,
    },
    orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
  });

  const apps: CreditApplication[] = [];
  let remaining = requestedAmount;
  for (const cm of cms) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const available = cm.netCredit.minus(cm.appliedAmount);
    if (available.lessThanOrEqualTo(0)) continue;
    const draw = available.lessThan(remaining) ? available : remaining;
    const app = await applyCreditToInvoiceTx(
      tx,
      cm.id,
      invoiceId,
      draw,
      { ...ctx, reason: `via APPLIED_CREDIT payment ${appliedCreditPaymentNumber}` },
      appliedCreditPaymentId,
    );
    apps.push(app);
    remaining = remaining.minus(draw);
  }

  if (remaining.greaterThan(0)) {
    // Should not happen if the upfront balance check ran, but guard
    // anyway to surface any drift between check-time and consume-time.
    throw new Error(
      `Insufficient credit balance during FIFO consumption: ${remaining.toString()} short`,
    );
  }
  return apps;
}

// ---------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------

export async function recordPayment(
  db: PrismaClient,
  input: RecordPaymentInput,
  ctx?: AuditContext,
): Promise<PaymentWithApplications> {
  const data = recordPaymentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: data.customerId, deletedAt: null },
    });
    if (!customer) throw new Error(`Customer not found: ${data.customerId}`);

    const seq = await getNextSequence(tx, {
      name: PAYMENT_SEQUENCE_NAME,
      prefix: PAYMENT_PREFIX,
      useYear: true,
    });

    const amount = new Prisma.Decimal(data.amount);

    // Resolve the deposit account for the cash-receipt JE. APPLIED_CREDIT
    // moves no cash, so it needs none. For real receipts, honor the
    // operator's pick (a cash/bank ASSET or a credit-card LIABILITY),
    // validated the same way the bills/AP side validates its cash account;
    // fall back to the default Cash account (1110) when the caller omits
    // one (smoke scripts, older API clients). The chosen account is stored
    // on the Payment so a later reversal credits the exact same account.
    let cashAccount: { id: string; code: string } | null = null;
    if (data.method !== PaymentMethod.APPLIED_CREDIT) {
      if (data.cashAccountId) {
        const acct = await tx.glAccount.findUnique({
          where: { id: data.cashAccountId },
          select: { id: true, code: true, type: true, active: true, deletedAt: true },
        });
        if (!acct || acct.deletedAt) {
          throw new Error(`GlAccount not found: ${data.cashAccountId}`);
        }
        if (
          acct.type !== AccountType.ASSET &&
          acct.type !== AccountType.LIABILITY
        ) {
          throw new Error(
            `cashAccountId must point at an ASSET- or LIABILITY-type GlAccount; ${acct.code} is ${acct.type}`,
          );
        }
        if (!acct.active) {
          throw new Error(`GlAccount ${acct.code} is inactive`);
        }
        cashAccount = { id: acct.id, code: acct.code };
      } else {
        const acct = await tx.glAccount.findUnique({
          where: { code: CASH_ACCOUNT },
          select: { id: true, code: true },
        });
        if (!acct) {
          throw new Error(`Default cash account ${CASH_ACCOUNT} not found`);
        }
        cashAccount = { id: acct.id, code: acct.code };
      }
    }

    const payment = await tx.payment.create({
      data: {
        number: seq.formatted,
        customerId: data.customerId,
        method: data.method,
        status: PaymentStatus.RECORDED,
        amount,
        appliedAmount: new Prisma.Decimal(0),
        currency: data.currency ?? 'USD',
        receivedAt: data.receivedAt ?? new Date(),
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        cashAccountId: cashAccount?.id ?? null,
      },
    });

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'Payment',
      entityId: payment.id,
      after: payment,
      ctx,
    });

    if (data.method === PaymentMethod.APPLIED_CREDIT) {
      // 1. Validate sufficient CM credit available.
      const available = await getAvailableCmCredit(tx, data.customerId);
      if (available.lessThan(amount)) {
        throw new Error(
          `Insufficient credit balance: customer has ${available.toString()} but APPLIED_CREDIT payment requires ${amount.toString()}`,
        );
      }
      // 2. Per application, walk CMs FIFO and create CREDIT_TO_INVOICE
      //    applications. The Payment row itself stays at appliedAmount=0;
      //    its applications are the CM-linked applications, not
      //    PAYMENT_TO_INVOICE rows linked to this synthetic Payment.
      // 3. NO cash-receipt JE — cash didn't move.
      for (const app of data.applications!) {
        await applyFifoCmCreditTx(
          tx,
          data.customerId,
          app.invoiceId,
          new Prisma.Decimal(app.amount),
          payment.id,
          payment.number,
          ctx,
        );
      }
    } else {
      // Standard cash-receipt path. JE first so the GL records the
      // receipt before any application drift. Apps next. cashAccount is
      // always resolved on this branch (only APPLIED_CREDIT skips it).
      if (!cashAccount) {
        throw new Error('Cash account not resolved for cash-receipt payment');
      }
      await post(tx, {
        entityType: 'Payment',
        entityId: payment.id,
        description: `Payment ${payment.number} from ${customer.name}`,
        lines: [
          { accountCode: cashAccount.code, debit: amount, memo: 'Cash receipt' },
          { accountCode: AR_ACCOUNT, credit: amount, memo: 'AR — payment received' },
        ],
      });
      if (data.applications && data.applications.length > 0) {
        for (const app of data.applications) {
          const created = await applyPaymentToInvoiceTx(
            tx,
            payment.id,
            app.invoiceId,
            new Prisma.Decimal(app.amount),
            ctx,
          );
          // Commission accrual fires per-application after the
          // CreditApplication row inserts. APPLIED_CREDIT path is
          // gated out at the outer if/else (Q1: no accrual on
          // credit-funded payments). Same tx as the application so
          // a downstream throw rolls everything back together.
          await accrueCommissionForApplicationTx(tx, created, ctx);
        }
      }
    }

    const final = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { applications: true },
    });
    return final;
  });
}

// ---------------------------------------------------------------------------
// reversePayment
// ---------------------------------------------------------------------------

export async function reversePayment(
  db: PrismaClient,
  input: ReversePaymentInput,
  ctx?: AuditContext,
): Promise<PaymentWithApplications> {
  const data = reversePaymentInputSchema.parse(input);
  return db.$transaction(async (tx) =>
    reversePaymentTx(tx, data, ctx),
  );
}

/**
 * Transaction-aware reverse-payment. Lifted out of reversePayment so
 * higher-level operations (reopenSalesOrder, future bulk-reverse jobs)
 * can compose payment reversal atomically with their own state changes.
 * Callers must already hold an open Prisma transaction.
 */
export async function reversePaymentTx(
  tx: Prisma.TransactionClient,
  input: ReversePaymentInput,
  ctx?: AuditContext,
): Promise<PaymentWithApplications> {
  const data = reversePaymentInputSchema.parse(input);
  await lockPayment(tx, data.paymentId);
  const before = await tx.payment.findUnique({
    where: { id: data.paymentId },
    include: { applications: true, cashAccount: { select: { code: true } } },
  });
  if (!before) throw new Error(`Payment not found: ${data.paymentId}`);
  if (before.deletedAt) throw new Error('Payment is soft-deleted');
  if (before.status === PaymentStatus.REVERSED) {
    throw new Error('Payment is already REVERSED');
  }

  const customer = await tx.customer.findUniqueOrThrow({
    where: { id: before.customerId },
  });

  // Mark all non-reversed applications as reversed; recompute each
  // affected invoice.
  const affectedInvoiceIds = new Set<string>();
  const now = new Date();
  for (const app of before.applications) {
    if (app.reversedAt != null) continue;
    await tx.creditApplication.update({
      where: { id: app.id },
      data: { reversedAt: now },
    });
    affectedInvoiceIds.add(app.invoiceId);
  }
  for (const invoiceId of affectedInvoiceIds) {
    await recomputeAmountPaidForInvoice(tx, invoiceId);
  }

  const after = await tx.payment.update({
    where: { id: data.paymentId },
    data: {
      status: PaymentStatus.REVERSED,
      reversedAt: now,
      reversedReason: data.reason,
      appliedAmount: new Prisma.Decimal(0),
    },
    include: { applications: true },
  });

  // Reversal JE — only for non-APPLIED_CREDIT payments. APPLIED_CREDIT
  // payments never posted a cash-receipt JE in the first place; their
  // CM-linked applications above are now reversed, so the original CM
  // confirmation JE remains in effect (the CM still has its credit).
  if (before.method !== PaymentMethod.APPLIED_CREDIT) {
    await post(tx, {
      entityType: 'Payment',
      entityId: data.paymentId,
      description: `Reversal of payment ${before.number}: ${data.reason}`,
      // Credit the exact account the original receipt debited. Legacy rows
      // (no stored cashAccountId) predate the deposit-account picker and
      // always posted to 1110, so the fallback reverses them correctly.
      lines: [
        { accountCode: AR_ACCOUNT, debit: before.amount, memo: 'AR — payment reversed' },
        {
          accountCode: before.cashAccount?.code ?? CASH_ACCOUNT,
          credit: before.amount,
          memo: 'Cash reversed',
        },
      ],
    });
  }

  // Commission reversal. APPLIED_CREDIT payments never accrued
  // commission in the first place (Q1) so the lookup is a no-op
  // there; the explicit gate is for clarity. triggeringPaymentId
  // = sourcePaymentId for self-reversals (the only path today).
  if (before.method !== PaymentMethod.APPLIED_CREDIT) {
    await reverseCommissionForPaymentTx(tx, data.paymentId, data.paymentId, ctx);
  }

  await audit(tx, {
    action: AuditAction.PAYMENT_REVERSED,
    entityType: 'Payment',
    entityId: data.paymentId,
    before: { status: before.status },
    after: { status: after.status, reversedAt: after.reversedAt },
    ctx: { ...ctx, reason: data.reason },
  });

  void customer;
  return after;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getPayment(
  db: PrismaClient,
  paymentId: string,
  // Optional data-scope fragment (lib/permissions/scope.paymentScopeWhere).
  // Out-of-scope payments resolve to null → caller renders not-found.
  scope?: Prisma.PaymentWhereInput,
): Promise<PaymentWithApplications | null> {
  return db.payment.findFirst({
    where: { AND: [{ id: paymentId, deletedAt: null }, scope ?? {}] },
    include: { applications: true },
  });
}

export type PaymentListFilters = {
  customerId?: string;
  status?: PaymentStatus | PaymentStatus[];
  receivedAtFrom?: Date;
  receivedAtTo?: Date;
  q?: string; // matches number or reference (case-insensitive)
  skip?: number;
  take?: number;
};

export async function listPayments(
  db: PrismaClient,
  filters: PaymentListFilters = {},
): Promise<PaymentWithApplications[]> {
  const {
    customerId,
    status,
    receivedAtFrom,
    receivedAtTo,
    q,
    skip = 0,
    take = 100,
  } = filters;
  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (receivedAtFrom) dateFilter.gte = receivedAtFrom;
  if (receivedAtTo) dateFilter.lte = receivedAtTo;
  return db.payment.findMany({
    where: {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
      ...(status
        ? { status: Array.isArray(status) ? { in: status } : status }
        : {}),
      ...(receivedAtFrom || receivedAtTo ? { receivedAt: dateFilter } : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' as const } },
              { reference: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: { applications: true },
    orderBy: { receivedAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

// ---------------------------------------------------------------------------
// listPaymentsPaged — list-page read with total count, method filter,
// customer join, and sortable date/amount. Mirrors listCreditMemosPaged.
// ---------------------------------------------------------------------------

export type PaymentSortField = 'receivedAt' | 'amount';
export type SortDir = 'asc' | 'desc';

export type PaymentListPagedFilters = {
  customerId?: string;
  status?: PaymentStatus;
  method?: PaymentMethod;
  receivedAtFrom?: Date;
  receivedAtTo?: Date;
  q?: string;
  // Data-scope fragment from lib/permissions/scope.paymentScopeWhere.
  scope?: Prisma.PaymentWhereInput;
  sort?: PaymentSortField;
  dir?: SortDir;
  skip?: number;
  take?: number;
};

// Each row carries the customer (for the Customer column) and its
// applications enriched with the invoice + SO link so the list can
// compute applied/unapplied and navigate a row to the source SO.
export type PaymentListPagedRow = Payment & {
  customer: { id: string; code: string; name: string };
  applications: Array<
    CreditApplication & {
      invoice: { id: string; number: string; salesOrderId: string | null };
    }
  >;
};

export async function listPaymentsPaged(
  db: PrismaClient,
  filters: PaymentListPagedFilters = {},
): Promise<{ rows: PaymentListPagedRow[]; total: number }> {
  const {
    customerId,
    status,
    method,
    receivedAtFrom,
    receivedAtTo,
    q,
    scope,
    sort = 'receivedAt',
    dir = 'desc',
    skip = 0,
    take = 20,
  } = filters;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (receivedAtFrom) dateFilter.gte = receivedAtFrom;
  if (receivedAtTo) dateFilter.lte = receivedAtTo;

  const base: Prisma.PaymentWhereInput = {
    deletedAt: null,
    ...(customerId ? { customerId } : {}),
    ...(status ? { status } : {}),
    ...(method ? { method } : {}),
    ...(receivedAtFrom || receivedAtTo ? { receivedAt: dateFilter } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: 'insensitive' as const } },
            { reference: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  // AND the scope so it can't be widened by the q OR-branch.
  const where: Prisma.PaymentWhereInput = scope
    ? { AND: [base, scope] }
    : base;

  const [rows, total] = await Promise.all([
    db.payment.findMany({
      where,
      include: {
        customer: { select: { id: true, code: true, name: true } },
        applications: {
          include: {
            invoice: {
              select: { id: true, number: true, salesOrderId: true },
            },
          },
        },
      },
      orderBy: { [sort]: dir },
      skip,
      take: Math.min(take, 200),
    }),
    db.payment.count({ where }),
  ]);

  return { rows, total };
}
