import {
  AuditAction,
  BillStatus,
  Prisma,
  VendorCreditStatus,
} from '@/generated/tenant';
import type {
  PrismaClient,
  VendorCredit,
  VendorCreditApplication,
  VendorCreditLine,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { post } from '@/lib/gl/post';
import { getNextSequence } from '@/lib/sequences/sequences';
import {
  applyVendorCreditInputSchema,
  cancelVendorCreditInputSchema,
  createVendorCreditInputSchema,
  updateVendorCreditInputSchema,
  type ApplyVendorCreditInput,
  type CancelVendorCreditInput,
  type CreateVendorCreditInput,
  type UpdateVendorCreditInput,
  type VendorCreditLineInput,
} from '@/lib/validation/ap';
import { recomputeBillDenormsTx } from './bills';

// =============================================================================
// VendorCredit service. Spec: docs/07-accounts-payable.md#vendor-credits.
//
// Three states:
//   DRAFT     — created, no GL effect, no AP effect. Editable in full.
//   CONFIRMED — posted to GL (DR 2010 AP / CR 2030 Vendor Credits Available
//               per spec docs/07:159). From here, the credit can be applied
//               to confirmed bills via applyVendorCreditToBill.
//   CANCELLED — terminal. From DRAFT: just flips status. From CONFIRMED:
//               offsetting JE posted; refused if appliedAmount > 0.
//
// Apply semantics (per spec docs/07:160 "DR AP / CR AP — net effect: bill
// reduced"): the application doesn't post a fresh JE — the AP-side
// reduction was already captured at confirm time. Apply is a pure
// denormalization update on Bill.amountCredited + VC.appliedAmount,
// recorded as a VendorCreditApplication row for audit traceability.
// Reversal of an application is symmetric (clears reversedAt → reverses
// denorms).
//
// Lines are simple expense-style (description + amount) per pilot scope.
// Math invariant: SUM(line.amount) === amount, enforced at the service
// layer with a documented tolerance.
//
// Auto-confirmed VCs from BillPayment overpayment go through the
// billPayments service directly, not through this service's create+confirm
// — to keep them in the same transaction and to use a more specific JE
// description. They share the same JE shape and audit action.
// =============================================================================

const VC_SEQUENCE_NAME = 'vendor_credit';
const VC_PREFIX = 'VCM';

const AP_ACCOUNT = '2010';
const VENDOR_CREDITS_AVAILABLE_ACCOUNT = '2030';

const LINE_MATH_TOLERANCE = new Prisma.Decimal('0.001');

export type VendorCreditWithLines = VendorCredit & { lines: VendorCreditLine[] };

// ---------------------------------------------------------------------------
// Internal: line math validation
// ---------------------------------------------------------------------------

function validateLineSum(
  amount: Prisma.Decimal,
  lines: ReadonlyArray<VendorCreditLineInput>,
): void {
  const sum = lines.reduce(
    (acc, l) => acc.plus(new Prisma.Decimal(l.amount)),
    new Prisma.Decimal(0),
  );
  const diff = sum.minus(amount).abs();
  if (diff.greaterThan(LINE_MATH_TOLERANCE)) {
    throw new Error(
      `Line totals $${sum.toString()} don't match credit amount $${amount.toString()}; difference $${diff.toString()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// createVendorCreditDraft
// ---------------------------------------------------------------------------

export async function createVendorCreditDraft(
  db: PrismaClient,
  input: CreateVendorCreditInput,
  ctx?: AuditContext,
): Promise<VendorCreditWithLines> {
  const data = createVendorCreditInputSchema.parse(input);
  const amount = new Prisma.Decimal(data.amount);
  validateLineSum(amount, data.lines);

  return db.$transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({
      where: { id: data.vendorId, deletedAt: null },
      select: { id: true },
    });
    if (!vendor) throw new Error(`Vendor not found: ${data.vendorId}`);

    const seq = await getNextSequence(tx, {
      name: VC_SEQUENCE_NAME,
      prefix: VC_PREFIX,
      useYear: true,
    });
    const vc = await tx.vendorCredit.create({
      data: {
        number: seq.formatted,
        vendorId: vendor.id,
        status: VendorCreditStatus.DRAFT,
        creditDate: data.creditDate ?? new Date(),
        amount,
        currency: data.currency ?? 'USD',
        reason: data.reason ?? null,
        notes: data.notes ?? null,
        createdById: ctx?.userId ?? null,
        lines: {
          create: data.lines.map((l, idx) => ({
            lineNumber: idx + 1,
            description: l.description,
            amount: new Prisma.Decimal(l.amount),
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'VendorCredit',
      entityId: vc.id,
      after: vc,
      ctx,
    });
    return vc;
  });
}

// ---------------------------------------------------------------------------
// updateVendorCredit — DRAFT-only, replace-all lines pattern
// ---------------------------------------------------------------------------

export async function updateVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
  input: UpdateVendorCreditInput,
  ctx?: AuditContext,
): Promise<VendorCreditWithLines> {
  const data = updateVendorCreditInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VendorCredit" WHERE "id" = ${vendorCreditId} FOR UPDATE`;
    const before = await tx.vendorCredit.findUnique({
      where: { id: vendorCreditId },
      include: { lines: true },
    });
    if (!before) throw new Error(`VendorCredit not found: ${vendorCreditId}`);
    if (before.deletedAt) throw new Error('VendorCredit is soft-deleted');
    if (before.status !== VendorCreditStatus.DRAFT) {
      throw new Error(
        `Cannot edit VendorCredit in status ${before.status} (only DRAFT is editable)`,
      );
    }

    const nextAmount = data.amount != null
      ? new Prisma.Decimal(data.amount)
      : before.amount;

    if (data.lines) {
      validateLineSum(nextAmount, data.lines);
      await tx.vendorCreditLine.deleteMany({
        where: { vendorCreditId },
      });
      await tx.vendorCreditLine.createMany({
        data: data.lines.map((l, idx) => ({
          vendorCreditId,
          lineNumber: idx + 1,
          description: l.description,
          amount: new Prisma.Decimal(l.amount),
          notes: l.notes ?? null,
        })),
      });
    } else if (data.amount != null) {
      // Amount changed without supplying lines — only allow when the
      // existing line sum still matches.
      const existingAsInput: VendorCreditLineInput[] = before.lines.map((l) => ({
        description: l.description,
        amount: l.amount.toString(),
        notes: l.notes ?? undefined,
      }));
      validateLineSum(nextAmount, existingAsInput);
    }

    const after = await tx.vendorCredit.update({
      where: { id: vendorCreditId },
      data: {
        amount: nextAmount,
        creditDate: data.creditDate ?? before.creditDate,
        reason: data.reason !== undefined ? data.reason : before.reason,
        notes: data.notes !== undefined ? data.notes : before.notes,
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorCredit',
      entityId: vendorCreditId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// confirmVendorCredit — posts JE: DR 2010 AP / CR 2030 VCA
// ---------------------------------------------------------------------------

export async function confirmVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
  ctx?: AuditContext,
): Promise<VendorCreditWithLines> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VendorCredit" WHERE "id" = ${vendorCreditId} FOR UPDATE`;
    const before = await tx.vendorCredit.findUnique({
      where: { id: vendorCreditId },
      include: { lines: true },
    });
    if (!before) throw new Error(`VendorCredit not found: ${vendorCreditId}`);
    if (before.deletedAt) throw new Error('VendorCredit is soft-deleted');
    if (before.status !== VendorCreditStatus.DRAFT) {
      throw new Error(
        `Cannot confirm VendorCredit in status ${before.status} (only DRAFT can be confirmed)`,
      );
    }

    if (before.amount.greaterThan(0)) {
      await post(tx, {
        entityType: 'VendorCredit',
        entityId: before.id,
        description: `Confirm vendor credit ${before.number}`,
        postedAt: before.creditDate,
        lines: [
          {
            accountCode: AP_ACCOUNT,
            debit: before.amount,
            memo: `AP relief — vendor credit ${before.number}`,
          },
          {
            accountCode: VENDOR_CREDITS_AVAILABLE_ACCOUNT,
            credit: before.amount,
            memo: `Vendor credit issued — pending application`,
          },
        ],
      });
    }

    const after = await tx.vendorCredit.update({
      where: { id: vendorCreditId },
      data: {
        status: VendorCreditStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.VENDOR_CREDIT_CONFIRMED,
      entityType: 'VendorCredit',
      entityId: vendorCreditId,
      before: { status: before.status },
      after: { status: after.status, confirmedAt: after.confirmedAt },
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// cancelVendorCredit — DRAFT: status flip; CONFIRMED: refuse if applied,
//                       else post offsetting JE
// ---------------------------------------------------------------------------

export async function cancelVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
  input: CancelVendorCreditInput,
  ctx?: AuditContext,
): Promise<VendorCreditWithLines> {
  const data = cancelVendorCreditInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VendorCredit" WHERE "id" = ${vendorCreditId} FOR UPDATE`;
    const before = await tx.vendorCredit.findUnique({
      where: { id: vendorCreditId },
      include: { lines: true },
    });
    if (!before) throw new Error(`VendorCredit not found: ${vendorCreditId}`);
    if (before.deletedAt) throw new Error('VendorCredit is soft-deleted');
    if (before.status === VendorCreditStatus.CANCELLED) {
      throw new Error('VendorCredit is already CANCELLED');
    }

    const now = new Date();

    if (before.status === VendorCreditStatus.DRAFT) {
      const after = await tx.vendorCredit.update({
        where: { id: vendorCreditId },
        data: {
          status: VendorCreditStatus.CANCELLED,
          cancelledAt: now,
          cancelReason: data.reason,
        },
        include: { lines: true },
      });
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'VendorCredit',
        entityId: vendorCreditId,
        before: { status: before.status },
        after: { status: after.status },
        ctx: { ...ctx, reason: data.reason },
      });
      return after;
    }

    // CONFIRMED → CANCELLED. Refuse if any non-reversed application
    // exists. Operator must reverse those first.
    if (before.appliedAmount.greaterThan(0)) {
      throw new Error(
        'Cannot cancel a confirmed vendor credit with applied balance. Reverse the applications first.',
      );
    }

    if (before.amount.greaterThan(0)) {
      await post(tx, {
        entityType: 'VendorCredit',
        entityId: vendorCreditId,
        description: `Cancel vendor credit ${before.number}: ${data.reason}`,
        postedAt: now,
        lines: [
          {
            accountCode: VENDOR_CREDITS_AVAILABLE_ACCOUNT,
            debit: before.amount,
            memo: `Reverse VC issuance (cancel ${before.number})`,
          },
          {
            accountCode: AP_ACCOUNT,
            credit: before.amount,
            memo: `Restore AP — vendor credit cancelled`,
          },
        ],
      });
    }

    const after = await tx.vendorCredit.update({
      where: { id: vendorCreditId },
      data: {
        status: VendorCreditStatus.CANCELLED,
        cancelledAt: now,
        cancelReason: data.reason,
      },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'VendorCredit',
      entityId: vendorCreditId,
      before: { status: before.status },
      after: { status: after.status, cancelledAt: after.cancelledAt },
      ctx: { ...ctx, reason: data.reason },
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// applyVendorCreditToBill — pure denorm update, NO GL JE per spec.
//                           Uses a partial-unique-index-protected
//                           VendorCreditApplication row for audit + idempotency.
// ---------------------------------------------------------------------------

export async function applyVendorCreditToBill(
  db: PrismaClient,
  vendorCreditId: string,
  input: ApplyVendorCreditInput,
  ctx?: AuditContext,
): Promise<VendorCreditApplication> {
  const data = applyVendorCreditInputSchema.parse(input);
  const amount = new Prisma.Decimal(data.amount);

  return db.$transaction(async (tx) => {
    // Lock both VC and bill for the duration. Acquire in deterministic
    // order (VC first by id) to avoid deadlocks across concurrent
    // applies that touch the same pair.
    const lockOrder = [vendorCreditId, data.billId].sort();
    for (const id of lockOrder) {
      // Polymorphic over the two tables — issue both locks via raw SQL.
      // The lock target depends on which id this is, but since both tables
      // are exclusive (different table names), we issue two separate
      // statements rather than try to combine.
      if (id === vendorCreditId) {
        await tx.$executeRaw`SELECT 1 FROM "VendorCredit" WHERE "id" = ${id} FOR UPDATE`;
      } else {
        await tx.$executeRaw`SELECT 1 FROM "Bill" WHERE "id" = ${id} FOR UPDATE`;
      }
    }

    const vc = await tx.vendorCredit.findUnique({
      where: { id: vendorCreditId },
      select: {
        id: true,
        number: true,
        vendorId: true,
        status: true,
        amount: true,
        appliedAmount: true,
        deletedAt: true,
      },
    });
    if (!vc) throw new Error(`VendorCredit not found: ${vendorCreditId}`);
    if (vc.deletedAt) throw new Error('VendorCredit is soft-deleted');
    if (vc.status !== VendorCreditStatus.CONFIRMED) {
      throw new Error(
        `Cannot apply VendorCredit in status ${vc.status} (only CONFIRMED can be applied)`,
      );
    }

    const bill = await tx.bill.findUnique({
      where: { id: data.billId },
      select: {
        id: true,
        number: true,
        vendorId: true,
        status: true,
        total: true,
        amountPaid: true,
        amountCredited: true,
        deletedAt: true,
      },
    });
    if (!bill) throw new Error(`Bill not found: ${data.billId}`);
    if (bill.deletedAt) throw new Error('Bill is soft-deleted');
    if (bill.status !== BillStatus.CONFIRMED) {
      throw new Error(
        `Cannot apply credit to bill in status ${bill.status} (only CONFIRMED accepts applications)`,
      );
    }
    if (bill.vendorId !== vc.vendorId) {
      throw new Error(
        `Cross-vendor application: VC ${vc.number} (vendor ${vc.vendorId}) cannot apply to bill ${bill.number} (vendor ${bill.vendorId})`,
      );
    }

    const vcRemaining = vc.amount.minus(vc.appliedAmount);
    if (amount.greaterThan(vcRemaining)) {
      throw new Error(
        `Application amount $${amount.toString()} exceeds VC remaining balance $${vcRemaining.toString()}`,
      );
    }
    const billRemaining = bill.total
      .minus(bill.amountPaid)
      .minus(bill.amountCredited);
    if (amount.greaterThan(billRemaining)) {
      throw new Error(
        `Application amount $${amount.toString()} exceeds bill remaining balance $${billRemaining.toString()}`,
      );
    }

    // Create application row. Partial unique index
    // vendorcreditapplication_live_idx prevents multi-applying the same
    // (vc, bill) pair while non-reversed — operator must reverse the
    // existing one first.
    const application = await tx.vendorCreditApplication.create({
      data: {
        vendorCreditId,
        billId: bill.id,
        amount,
        appliedById: ctx?.userId ?? null,
        notes: data.notes ?? null,
      },
    });

    // Bump VC.appliedAmount denorm.
    await tx.vendorCredit.update({
      where: { id: vendorCreditId },
      data: { appliedAmount: vc.appliedAmount.plus(amount) },
    });

    // Recompute the bill's amountCredited + paymentStatus.
    await recomputeBillDenormsTx(tx, bill.id);

    await audit(tx, {
      action: AuditAction.VENDOR_CREDIT_APPLIED,
      entityType: 'VendorCreditApplication',
      entityId: application.id,
      after: application,
      ctx,
    });

    return application;
  });
}

// ---------------------------------------------------------------------------
// reverseVendorCreditApplication — sets reversedAt, recomputes denorms.
// No GL JE (mirror of apply).
// ---------------------------------------------------------------------------

export async function reverseVendorCreditApplication(
  db: PrismaClient,
  applicationId: string,
  reason: string,
  ctx?: AuditContext,
): Promise<VendorCreditApplication> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('reverseVendorCreditApplication requires a non-empty reason');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VendorCreditApplication" WHERE "id" = ${applicationId} FOR UPDATE`;
    const before = await tx.vendorCreditApplication.findUnique({
      where: { id: applicationId },
    });
    if (!before) {
      throw new Error(`VendorCreditApplication not found: ${applicationId}`);
    }
    if (before.reversedAt) {
      throw new Error('VendorCreditApplication is already reversed');
    }

    const now = new Date();
    const after = await tx.vendorCreditApplication.update({
      where: { id: applicationId },
      data: { reversedAt: now },
    });

    // Drop VC.appliedAmount.
    const vc = await tx.vendorCredit.findUniqueOrThrow({
      where: { id: before.vendorCreditId },
      select: { appliedAmount: true },
    });
    await tx.vendorCredit.update({
      where: { id: before.vendorCreditId },
      data: { appliedAmount: vc.appliedAmount.minus(before.amount) },
    });

    // Recompute the bill's denorms.
    await recomputeBillDenormsTx(tx, before.billId);

    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'VendorCreditApplication',
      entityId: applicationId,
      before: { reversedAt: null },
      after: { reversedAt: after.reversedAt },
      ctx: { ...ctx, reason },
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
): Promise<VendorCreditWithLines | null> {
  return db.vendorCredit.findFirst({
    where: { id: vendorCreditId, deletedAt: null },
    include: {
      lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
    },
  });
}

export type VendorCreditListFilters = {
  vendorId?: string;
  status?: VendorCreditStatus | VendorCreditStatus[];
  q?: string;
  skip?: number;
  take?: number;
};

function vendorCreditWhere(
  filters: Omit<VendorCreditListFilters, 'skip' | 'take'>,
): Prisma.VendorCreditWhereInput {
  const { vendorId, status, q } = filters;
  return {
    deletedAt: null,
    ...(vendorId ? { vendorId } : {}),
    ...(status
      ? { status: Array.isArray(status) ? { in: status } : status }
      : {}),
    ...(q ? { number: { contains: q, mode: 'insensitive' as const } } : {}),
  };
}

export async function listVendorCredits(
  db: PrismaClient,
  filters: VendorCreditListFilters = {},
): Promise<VendorCreditWithLines[]> {
  const { skip = 0, take = 100, ...rest } = filters;
  return db.vendorCredit.findMany({
    where: vendorCreditWhere(rest),
    include: {
      lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take: Math.min(take, 500),
  });
}

/**
 * Paginated variant. Returns `{ rows, total }` with the VC's vendor
 * (id, code, name) eager-loaded so the list table can render the vendor
 * column without a second round-trip. Same filter semantics as
 * listVendorCredits.
 */
export async function listVendorCreditsPaged(
  db: PrismaClient,
  filters: VendorCreditListFilters = {},
): Promise<{
  rows: Array<
    VendorCredit & {
      lines: VendorCreditLine[];
      vendor: { id: string; code: string; name: string };
    }
  >;
  total: number;
}> {
  const { skip = 0, take = 100, ...rest } = filters;
  const where = vendorCreditWhere(rest);
  const [rows, total] = await Promise.all([
    db.vendorCredit.findMany({
      where,
      include: {
        lines: { where: { deletedAt: null }, orderBy: { lineNumber: 'asc' } },
        vendor: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(take, 500),
    }),
    db.vendorCredit.count({ where }),
  ]);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// softDeleteVendorCredit — DRAFT only
// ---------------------------------------------------------------------------

export async function softDeleteVendorCredit(
  db: PrismaClient,
  vendorCreditId: string,
  ctx?: AuditContext,
): Promise<VendorCreditWithLines> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VendorCredit" WHERE "id" = ${vendorCreditId} FOR UPDATE`;
    const before = await tx.vendorCredit.findUnique({
      where: { id: vendorCreditId },
      include: { lines: true },
    });
    if (!before) throw new Error(`VendorCredit not found: ${vendorCreditId}`);
    if (before.deletedAt) throw new Error('VendorCredit is already soft-deleted');
    if (before.status !== VendorCreditStatus.DRAFT) {
      throw new Error(
        `Cannot soft-delete VendorCredit in status ${before.status} (only DRAFT). Cancel CONFIRMED credits instead.`,
      );
    }
    const after = await tx.vendorCredit.update({
      where: { id: vendorCreditId },
      data: { deletedAt: new Date() },
      include: { lines: true },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'VendorCredit',
      entityId: vendorCreditId,
      before,
      after,
      ctx,
    });
    return after;
  });
}
