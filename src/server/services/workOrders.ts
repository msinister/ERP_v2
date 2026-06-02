import {
  AuditAction,
  InventoryMovementType,
  Prisma,
  ProductType,
  WorkOrderStatus,
} from '@/generated/tenant';
import type {
  PrismaClient,
  ProductVariant,
  WorkOrder,
  WorkOrderComponent,
  WorkOrderCompletion,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { getNextSequence } from '@/lib/sequences/sequences';
import { lockBin } from '@/server/services/locks';
import {
  consumeFromLayersTx,
  createFifoLayerForReturnTx,
} from '@/server/services/fifoLayers';
import { recomputeOnHand } from '@/server/services/movements';
import { markProductsDirtyFromVariants } from '@/server/services/inventoryPushTriggers';
import { getNegativeInventoryAllowed } from '@/server/services/negativeInventory';
import { post } from '@/lib/gl/post';
import {
  cancelWorkOrderInputSchema,
  completeWorkOrderInputSchema,
  createWorkOrderInputSchema,
  updateWorkOrderInputSchema,
  type CancelWorkOrderInput,
  type CompleteWorkOrderInput,
  type CreateWorkOrderInput,
  type UpdateWorkOrderInput,
} from '@/lib/validation/workOrders';

const WO_SEQUENCE_NAME = 'work_order';
const WO_PREFIX = 'WO';
const DIRECT_LABOR_ACCOUNT_CODE = '5300';

export type WorkOrderWithChildren = WorkOrder & {
  components: (WorkOrderComponent & { componentVariant: ProductVariant })[];
  completions: WorkOrderCompletion[];
};

// Per-component warning emitted when completeWorkOrder consumed against
// less inventory than the build required. Only surfaces when the
// tenant-wide negativeInventoryAllowed setting is ON; when it's OFF,
// the same condition throws instead. Strings (not Decimals) so the API
// can pass them through to clients without precision loss.
export type NegativeAllocationWarning = {
  componentVariantId: string;
  needed: string;
  allocated: string;
  shortage: string;
};

export type CompleteWorkOrderResult = {
  workOrder: WorkOrderWithChildren;
  warnings: NegativeAllocationWarning[];
};

// =============================================================================
// Work Order service.
//
// Lifecycle:
//   create(productId, variantId, warehouseId, qtyToBuild, laborCost?)
//     → DRAFT (BOM snapshot copied; labor snapshotted from product or
//       overridden by caller; no inventory side effects)
//   start(woId) → IN_PROGRESS (labor + BOM snapshot frozen; still no
//     inventory effects)
//   complete(woId, { qtyToComplete }) → IN_PROGRESS (partial) or COMPLETED
//     (when qtyCompleted == qtyToBuild). Consumes components via FIFO,
//     produces a finished-good FIFO layer at rolled-up cost (component
//     FIFO cost per unit + per-unit labor), posts a balanced JE, and
//     records one WorkOrderCompletion row.
//   cancel(woId, { reason }) → CANCELLED, allowed from DRAFT or
//     IN_PROGRESS. Any already-completed units stay in inventory; the
//     remaining qty is simply abandoned.
//
// All mutations write audit rows; the completion path also produces
// InventoryMovement audit rows (one BUILD_CONSUME per component, one
// BUILD_PRODUCE for the finished good) and a posted JournalEntry.
// =============================================================================

export async function createWorkOrder(
  db: PrismaClient,
  input: CreateWorkOrderInput,
  ctx?: AuditContext,
): Promise<WorkOrderWithChildren> {
  const data = createWorkOrderInputSchema.parse(input);

  return db.$transaction(async (tx) => {
    // Validate parent product is BOM-eligible + load its BOM. The BOM
    // is snapshotted into WorkOrderComponent at create time so a
    // subsequent BOM edit doesn't change what an open WO consumes.
    const product = await tx.product.findUnique({
      where: { id: data.productId },
      include: {
        bomLines: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!product || product.deletedAt != null) {
      throw new Error(`Product not found: ${data.productId}`);
    }
    if (
      product.type !== ProductType.SIMPLE &&
      product.type !== ProductType.ASSEMBLED
    ) {
      throw new Error(
        `Cannot create Work Order for Product type ${product.type} — only SIMPLE and ASSEMBLED are buildable`,
      );
    }
    if (product.bomLines.length === 0) {
      throw new Error(
        `Cannot create Work Order — Product ${data.productId} has no BOM lines defined`,
      );
    }

    // Validate the chosen variant belongs to this product. The UI
    // defaults to the only variant when there's one; this guard catches
    // operators or callers passing a stale id.
    const variant = await tx.productVariant.findUnique({
      where: { id: data.variantId },
      select: { id: true, productId: true, deletedAt: true },
    });
    if (!variant || variant.deletedAt != null) {
      throw new Error(`Variant not found: ${data.variantId}`);
    }
    if (variant.productId !== data.productId) {
      throw new Error(
        `Variant ${data.variantId} does not belong to Product ${data.productId}`,
      );
    }

    // Warehouse must exist + be active. (No active check today on
    // other paths — matches existing PO convention.)
    const warehouse = await tx.warehouse.findUnique({
      where: { id: data.warehouseId },
      select: { id: true, deletedAt: true },
    });
    if (!warehouse || warehouse.deletedAt != null) {
      throw new Error(`Warehouse not found: ${data.warehouseId}`);
    }

    // Labor snapshot: caller override (null = clear, decimal = set)
    // takes precedence; otherwise inherit from product.bomLaborCost.
    const laborCost: Prisma.Decimal | null =
      data.laborCost === undefined
        ? product.bomLaborCost
        : data.laborCost === null
          ? null
          : new Prisma.Decimal(data.laborCost);

    const seq = await getNextSequence(tx, {
      name: WO_SEQUENCE_NAME,
      prefix: WO_PREFIX,
      useYear: true,
    });

    const wo = await tx.workOrder.create({
      data: {
        number: seq.formatted,
        productId: data.productId,
        variantId: data.variantId,
        warehouseId: data.warehouseId,
        qtyToBuild: new Prisma.Decimal(data.qtyToBuild),
        laborCost,
        status: WorkOrderStatus.DRAFT,
        notes: data.notes,
        createdById: data.createdById,
      },
    });

    // Snapshot BOM rows. qtyRequiredPerUnit mirrors the source BOM
    // line as-is (no scaling by qtyToBuild — that multiplication
    // happens at completion time so partial builds compute cleanly).
    for (let i = 0; i < product.bomLines.length; i++) {
      const bl = product.bomLines[i];
      await tx.workOrderComponent.create({
        data: {
          workOrderId: wo.id,
          componentVariantId: bl.componentVariantId,
          qtyRequiredPerUnit: bl.qtyRequired,
          sortOrder: bl.sortOrder ?? i,
          notes: bl.notes,
        },
      });
    }

    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'WorkOrder',
      entityId: wo.id,
      after: wo,
      ctx: {
        userId: ctx?.userId ?? data.createdById ?? null,
        ipAddress: ctx?.ipAddress,
        reason: ctx?.reason,
      },
    });

    const fresh = await loadWorkOrderInTx(tx, wo.id);
    if (!fresh) throw new Error(`WorkOrder not found after create: ${wo.id}`);
    return fresh;
  });
}

export async function updateWorkOrder(
  db: PrismaClient,
  id: string,
  input: UpdateWorkOrderInput,
  ctx?: AuditContext,
): Promise<WorkOrderWithChildren> {
  const data = updateWorkOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.workOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`WorkOrder not found: ${id}`);
    if (before.status !== WorkOrderStatus.DRAFT) {
      throw new Error(
        `Cannot edit WorkOrder in status ${before.status} — only DRAFT is editable`,
      );
    }

    const updateData: Prisma.WorkOrderUpdateInput = {};
    if (data.laborCost !== undefined) {
      updateData.laborCost =
        data.laborCost === null ? null : new Prisma.Decimal(data.laborCost);
    }
    if (data.notes !== undefined) {
      updateData.notes = data.notes;
    }

    if (Object.keys(updateData).length === 0) {
      // No-op — return the existing row.
      const same = await loadWorkOrderInTx(tx, id);
      if (!same) throw new Error(`WorkOrder not found: ${id}`);
      return same;
    }

    const after = await tx.workOrder.update({
      where: { id },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'WorkOrder',
      entityId: id,
      before: { laborCost: before.laborCost, notes: before.notes },
      after: { laborCost: after.laborCost, notes: after.notes },
      ctx,
    });

    const fresh = await loadWorkOrderInTx(tx, id);
    if (!fresh) throw new Error(`WorkOrder not found after update: ${id}`);
    return fresh;
  });
}

export async function startWorkOrder(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<WorkOrderWithChildren> {
  return db.$transaction(async (tx) => {
    const before = await tx.workOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`WorkOrder not found: ${id}`);
    if (before.status !== WorkOrderStatus.DRAFT) {
      throw new Error(
        `Cannot start WorkOrder in status ${before.status} — only DRAFT can be started`,
      );
    }
    const after = await tx.workOrder.update({
      where: { id },
      data: {
        status: WorkOrderStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'WorkOrder',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status, startedAt: after.startedAt },
      ctx,
    });
    const fresh = await loadWorkOrderInTx(tx, id);
    if (!fresh) throw new Error(`WorkOrder not found after start: ${id}`);
    return fresh;
  });
}

export async function cancelWorkOrder(
  db: PrismaClient,
  id: string,
  input: CancelWorkOrderInput,
  ctx?: AuditContext,
): Promise<WorkOrderWithChildren> {
  const data = cancelWorkOrderInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.workOrder.findUnique({ where: { id } });
    if (!before) throw new Error(`WorkOrder not found: ${id}`);
    if (
      before.status !== WorkOrderStatus.DRAFT &&
      before.status !== WorkOrderStatus.IN_PROGRESS
    ) {
      throw new Error(
        `Cannot cancel WorkOrder in status ${before.status} — only DRAFT or IN_PROGRESS can be cancelled`,
      );
    }
    const after = await tx.workOrder.update({
      where: { id },
      data: {
        status: WorkOrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: data.reason,
      },
    });
    await audit(tx, {
      action: AuditAction.STATUS_CHANGE,
      entityType: 'WorkOrder',
      entityId: id,
      before: { status: before.status },
      after: {
        status: after.status,
        cancelledAt: after.cancelledAt,
        cancelReason: after.cancelReason,
      },
      ctx: { ...ctx, reason: data.reason },
    });
    const fresh = await loadWorkOrderInTx(tx, id);
    if (!fresh) throw new Error(`WorkOrder not found after cancel: ${id}`);
    return fresh;
  });
}

export async function getWorkOrder(
  db: PrismaClient,
  id: string,
): Promise<WorkOrderWithChildren | null> {
  return db.workOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      components: {
        include: { componentVariant: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      completions: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function listWorkOrdersPaged(
  db: PrismaClient,
  opts: {
    status?: WorkOrderStatus;
    productId?: string;
    warehouseId?: string;
    // Substring match on WO number OR product name (case-insensitive).
    q?: string;
    // Filter to WOs carrying ANY of these OrderTag ids.
    tagIds?: string[];
    skip?: number;
    take?: number;
  } = {},
): Promise<{
  rows: (WorkOrder & {
    product: { id: string; sku: string; name: string };
    variant: { id: string; sku: string; name: string | null };
    warehouse: { id: string; code: string; name: string };
    tags: Array<{ tag: { id: string; name: string } }>;
  })[];
  total: number;
}> {
  const where: Prisma.WorkOrderWhereInput = { deletedAt: null };
  if (opts.status) where.status = opts.status;
  if (opts.productId) where.productId = opts.productId;
  if (opts.warehouseId) where.warehouseId = opts.warehouseId;
  if (opts.tagIds && opts.tagIds.length > 0) {
    where.tags = { some: { tagId: { in: opts.tagIds } } };
  }
  if (opts.q) {
    where.OR = [
      { number: { contains: opts.q, mode: 'insensitive' as const } },
      {
        product: {
          name: { contains: opts.q, mode: 'insensitive' as const },
        },
      },
    ];
  }

  const [rows, total] = await Promise.all([
    db.workOrder.findMany({
      where,
      include: {
        product: { select: { id: true, sku: true, name: true } },
        variant: { select: { id: true, sku: true, name: true } },
        warehouse: { select: { id: true, code: true, name: true } },
        tags: {
          include: { tag: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: opts.skip ?? 0,
      take: opts.take ?? 50,
    }),
    db.workOrder.count({ where }),
  ]);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Completion — the heavy lift. Consumes components via FIFO, produces a
// finished-good FIFO layer at the rolled-up cost, posts a balanced JE,
// and records one WorkOrderCompletion row. Partial completions are
// allowed (qtyToComplete < remaining); the WO stays IN_PROGRESS until
// qtyCompleted reaches qtyToBuild.
// ---------------------------------------------------------------------------

export async function completeWorkOrder(
  db: PrismaClient,
  id: string,
  input: CompleteWorkOrderInput,
  ctx?: AuditContext,
): Promise<CompleteWorkOrderResult> {
  const data = completeWorkOrderInputSchema.parse(input);
  const qtyToComplete = new Prisma.Decimal(data.qtyToComplete);

  const result = await db.$transaction(async (tx) => {
    const wo = await tx.workOrder.findUnique({
      where: { id },
      include: {
        components: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!wo) throw new Error(`WorkOrder not found: ${id}`);
    if (wo.status !== WorkOrderStatus.IN_PROGRESS) {
      throw new Error(
        `Cannot complete WorkOrder in status ${wo.status} — only IN_PROGRESS can be completed`,
      );
    }
    if (wo.components.length === 0) {
      throw new Error(
        `WorkOrder ${wo.number} has no component snapshot — cannot complete`,
      );
    }

    const remaining = wo.qtyToBuild.minus(wo.qtyCompleted);
    if (qtyToComplete.greaterThan(remaining)) {
      throw new Error(
        `qtyToComplete (${qtyToComplete.toString()}) exceeds remaining (${remaining.toString()}) on WorkOrder ${wo.number}`,
      );
    }

    // Lock bins in deterministic order. We lock every component bin
    // PLUS the finished-good bin to serialize against concurrent
    // consumes (e.g., a SO closing on a component) and concurrent
    // produces (another WO on the same finished variant).
    const binSet = new Map<string, { variantId: string; warehouseId: string }>();
    binSet.set(`${wo.variantId}|${wo.warehouseId}`, {
      variantId: wo.variantId,
      warehouseId: wo.warehouseId,
    });
    for (const c of wo.components) {
      binSet.set(`${c.componentVariantId}|${wo.warehouseId}`, {
        variantId: c.componentVariantId,
        warehouseId: wo.warehouseId,
      });
    }
    const bins = Array.from(binSet.values()).sort((a, b) =>
      (a.variantId + a.warehouseId).localeCompare(b.variantId + b.warehouseId),
    );
    for (const b of bins) {
      await lockBin(tx, b.variantId, b.warehouseId);
    }

    // Look up warehouse inventory account once. Used for both the DR
    // (finished good) and the CR (each component) legs of the JE.
    const warehouse = await tx.warehouse.findUnique({
      where: { id: wo.warehouseId },
      select: {
        id: true,
        code: true,
        inventoryAccount: { select: { code: true } },
      },
    });
    if (!warehouse) throw new Error(`Warehouse not found: ${wo.warehouseId}`);
    if (!warehouse.inventoryAccount) {
      throw new Error(
        `Warehouse ${warehouse.code} has no inventoryAccount configured — cannot post Work Order completion`,
      );
    }
    const inventoryAccountCode = warehouse.inventoryAccount.code;

    // Shortage policy: when a component's available stock falls short
    // of what the build needs, we either reject (the default) or let
    // the build proceed with a negative allocation — controlled by the
    // tenant-wide negativeInventoryAllowed setting, same gate the
    // CONSUME path (movements.ts) honors for SO closes. Look it up
    // once before the loop so all components share the same policy.
    const negativeAllowed = await getNegativeInventoryAllowed(tx);

    // Per-component consume. Each emits one BUILD_CONSUME movement +
    // a FIFO walk. We capture the per-component actually-consumed cost
    // for the CR leg of the JE — when an allocation is partial (only
    // possible when negativeAllowed is on), only the portion backed
    // by FIFO layers contributes to the cost rollup.
    type ComponentConsumeResult = {
      componentVariantId: string;
      qtyNeeded: Prisma.Decimal;
      qtyAllocated: Prisma.Decimal;
      totalCost: Prisma.Decimal;
      negativeAllocation: boolean;
    };
    const consumeResults: ComponentConsumeResult[] = [];
    const warnings: NegativeAllocationWarning[] = [];

    for (const comp of wo.components) {
      const totalNeeded = comp.qtyRequiredPerUnit.times(qtyToComplete);

      // Create movement first (FifoConsumption.movementId needs an
      // existing row). unitCost gets backfilled after the FIFO walk.
      const movement = await tx.inventoryMovement.create({
        data: {
          variantId: comp.componentVariantId,
          warehouseId: wo.warehouseId,
          type: InventoryMovementType.BUILD_CONSUME,
          qty: totalNeeded.negated(),
          unitCost: null,
          reference: wo.number,
          notes: `Consumed for ${wo.number}`,
          createdById: ctx?.userId ?? null,
        },
      });

      const consume = await consumeFromLayersTx(tx, {
        variantId: comp.componentVariantId,
        warehouseId: wo.warehouseId,
        qty: totalNeeded,
        movementId: movement.id,
      });

      // qtyAllocated is the sum of what the FIFO walk actually pulled
      // out of layers. With fullyAllocated == true it equals
      // totalNeeded; with false (only reachable when negativeAllowed
      // is on) it's strictly less, and the gap is the negative
      // portion.
      const qtyAllocated = consume.consumptions.reduce(
        (acc, c) => acc.plus(c.qty),
        new Prisma.Decimal(0),
      );

      if (!consume.fullyAllocated) {
        if (!negativeAllowed) {
          // Default behavior — operator sees the shortage in the UI
          // and is expected to reduce qtyToComplete or receive more
          // stock first. Throw rolls back the whole transaction
          // including the placeholder movement above.
          throw new Error(
            `Insufficient inventory for component ${comp.componentVariantId} in warehouse ${wo.warehouseId} — needed ${totalNeeded.toString()}; reduce qtyToComplete or receive more stock`,
          );
        }
        // Negative-inventory mode — emit a warning the caller (API +
        // UI) can surface, mark the movement, and proceed. The cost
        // rollup uses only what was actually consumed from layers;
        // the negative portion contributes $0 to the produced layer
        // and the JE.
        warnings.push({
          componentVariantId: comp.componentVariantId,
          needed: totalNeeded.toString(),
          allocated: qtyAllocated.toString(),
          shortage: totalNeeded.minus(qtyAllocated).toString(),
        });
      }

      // Backfill movement.unitCost with the weighted average from the
      // FIFO walk. NULL when zero layers existed (matches the CONSUME
      // negative-allocation pattern in movements.ts). negativeAllocation
      // mirrors the same column the CONSUME path sets — downstream
      // reporting / reconciliation already filters on it.
      await tx.inventoryMovement.update({
        where: { id: movement.id },
        data: {
          unitCost: consume.weightedAverageCost,
          negativeAllocation: !consume.fullyAllocated,
        },
      });

      // totalCost is the actually-realized GL cost — only what came
      // from FIFO layers. weightedAverageCost is per-unit across the
      // consumed portion; multiplying by qtyAllocated gives the
      // realized cost. The negative portion contributes nothing.
      const totalCost = (
        consume.weightedAverageCost ?? new Prisma.Decimal(0)
      ).times(qtyAllocated);

      consumeResults.push({
        componentVariantId: comp.componentVariantId,
        qtyNeeded: totalNeeded,
        qtyAllocated,
        totalCost,
        negativeAllocation: !consume.fullyAllocated,
      });

      await recomputeOnHand(tx, comp.componentVariantId, wo.warehouseId);

      await audit(tx, {
        action: AuditAction.CREATE,
        entityType: 'InventoryMovement',
        entityId: movement.id,
        after: {
          ...movement,
          unitCost: consume.weightedAverageCost,
          negativeAllocation: !consume.fullyAllocated,
        },
        ctx,
      });
    }

    // Roll up the finished-good unit cost: (sum of component costs +
    // total labor) / qtyToComplete. Labor is per-unit and snapshotted
    // on the WO at create time.
    const totalComponentCost = consumeResults.reduce(
      (acc, c) => acc.plus(c.totalCost),
      new Prisma.Decimal(0),
    );
    const laborPerUnit = wo.laborCost ?? new Prisma.Decimal(0);
    const totalLaborCost = laborPerUnit.times(qtyToComplete);
    const totalProducedValue = totalComponentCost.plus(totalLaborCost);
    const unitCost = totalProducedValue.dividedBy(qtyToComplete);

    // Produce the finished-good layer + movement.
    const produceMovement = await tx.inventoryMovement.create({
      data: {
        variantId: wo.variantId,
        warehouseId: wo.warehouseId,
        type: InventoryMovementType.BUILD_PRODUCE,
        qty: qtyToComplete,
        unitCost,
        reference: wo.number,
        notes: `Produced by ${wo.number}`,
        createdById: ctx?.userId ?? null,
      },
    });
    // createFifoLayerForReturnTx is name-bound to RMA flows but the
    // contract (sourceMovementId-only, no receipt-line) is the same
    // semantics a build-produce needs. Reusing avoids a third near-
    // identical helper; rename when a fourth caller shows up.
    const producedLayer = await createFifoLayerForReturnTx(
      tx,
      {
        variantId: wo.variantId,
        warehouseId: wo.warehouseId,
        qty: qtyToComplete,
        unitCost,
        returnDate: new Date(),
        sourceMovementId: produceMovement.id,
      },
      ctx,
    );
    await recomputeOnHand(tx, wo.variantId, wo.warehouseId);
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'InventoryMovement',
      entityId: produceMovement.id,
      after: produceMovement,
      ctx,
    });

    // Post the journal entry. DR finished-good inventory; CR each
    // component's consumed cost; CR Direct Labor if labor > 0. All
    // inventory legs share the same per-warehouse account, so when
    // labor is 0 the JE nets to zero on that account — still posted
    // for audit traceability (post() accepts multi-leg same-account).
    const jeLines: Array<{
      accountCode: string;
      debit?: Prisma.Decimal;
      credit?: Prisma.Decimal;
      memo?: string;
    }> = [];

    jeLines.push({
      accountCode: inventoryAccountCode,
      debit: totalProducedValue,
      memo: `Finished good — ${wo.number} (${qtyToComplete.toString()} units)`,
    });

    for (const r of consumeResults) {
      if (r.totalCost.greaterThan(0)) {
        jeLines.push({
          accountCode: inventoryAccountCode,
          credit: r.totalCost,
          memo: `Component consumed — ${wo.number} (variant ${r.componentVariantId})`,
        });
      }
    }
    // Edge: all components had zero unit cost — finished good lands at
    // 0 (just labor, if any). Skip the zero-amount component lines so
    // post()'s "no zero-side line" guard doesn't reject. The DR may
    // also be zero in that case; we handle that below.
    if (totalLaborCost.greaterThan(0)) {
      jeLines.push({
        accountCode: DIRECT_LABOR_ACCOUNT_CODE,
        credit: totalLaborCost,
        memo: `Direct labor — ${wo.number} (${qtyToComplete.toString()} units)`,
      });
    }

    let journalEntryId: string | null = null;
    if (totalProducedValue.greaterThan(0)) {
      const je = await post(tx, {
        entityType: 'WorkOrderCompletion',
        entityId: produceMovement.id, // unique per completion event
        description: `Build completion — ${wo.number} (${qtyToComplete.toString()} units)`,
        lines: jeLines,
      });
      journalEntryId = je.id;
    }

    // Record the completion row. unitCost is the per-unit FIFO cost
    // we just produced (for verification / audit). qtyCompleted moves
    // up on the parent WO.
    const completion = await tx.workOrderCompletion.create({
      data: {
        workOrderId: wo.id,
        qtyCompleted: qtyToComplete,
        unitCost,
        totalLaborCost,
        producedLayerId: producedLayer.id,
        journalEntryId,
        createdById: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'WorkOrderCompletion',
      entityId: completion.id,
      after: completion,
      ctx,
    });

    // Bump the parent WO. Flip to COMPLETED when qtyCompleted hits
    // qtyToBuild; otherwise stay IN_PROGRESS.
    const newQtyCompleted = wo.qtyCompleted.plus(qtyToComplete);
    const nowCompleted = newQtyCompleted.greaterThanOrEqualTo(wo.qtyToBuild);
    const updated = await tx.workOrder.update({
      where: { id: wo.id },
      data: {
        qtyCompleted: newQtyCompleted,
        ...(nowCompleted
          ? { status: WorkOrderStatus.COMPLETED, completedAt: new Date() }
          : {}),
      },
    });
    if (nowCompleted) {
      await audit(tx, {
        action: AuditAction.STATUS_CHANGE,
        entityType: 'WorkOrder',
        entityId: wo.id,
        before: { status: WorkOrderStatus.IN_PROGRESS },
        after: {
          status: updated.status,
          qtyCompleted: updated.qtyCompleted,
          completedAt: updated.completedAt,
        },
        ctx,
      });
    } else {
      await audit(tx, {
        action: AuditAction.UPDATE,
        entityType: 'WorkOrder',
        entityId: wo.id,
        before: { qtyCompleted: wo.qtyCompleted },
        after: { qtyCompleted: updated.qtyCompleted },
        ctx,
      });
    }

    const fresh = await loadWorkOrderInTx(tx, wo.id);
    if (!fresh) throw new Error(`WorkOrder not found after complete: ${wo.id}`);
    return {
      workOrder: fresh,
      warnings,
      affectedVariantIds: [
        wo.variantId,
        ...wo.components.map((c) => c.componentVariantId),
      ],
    };
  }, { timeout: 30000 });
  // Shopify inventory push — BUILD_CONSUME drops component onHand;
  // BUILD_PRODUCE bumps finished-good onHand. Mark both sides dirty.
  await markProductsDirtyFromVariants(db, result.affectedVariantIds);
  return { workOrder: result.workOrder, warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadWorkOrderInTx(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<WorkOrderWithChildren | null> {
  return tx.workOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      components: {
        include: { componentVariant: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      completions: { orderBy: { createdAt: 'asc' } },
    },
  });
}
