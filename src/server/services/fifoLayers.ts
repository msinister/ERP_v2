import { AuditAction, Prisma } from '@/generated/tenant';
import type { FifoConsumption, FifoLayer } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';

// =============================================================================
// FifoLayers service — Part 1 of the costing engine.
//
// Layers are created on RECEIVE (one layer per ReceiptLine, sourced from
// ReceiptLine.unitCost) and consumed by CONSUME movements oldest-first
// (by receivedDate, with id as a deterministic tiebreaker). This service
// owns layer + per-layer-consumption mechanics; it does NOT update
// inventoryItem.onHand (that stays the caller's responsibility, will be
// composed in Phase 1C when consumeInventoryTx wires this in).
//
// Phase 1A note: not yet integrated with postReceipt / cancelReceipt /
// consumeInventoryTx. Direct callers in tests exercise these functions
// in isolation; production callers land in 1B / 1C.
//
// Concurrency: consumeFromLayersTx takes a SELECT ... FOR UPDATE on the
// candidate layer rows after the bin advisory lock (added in 1C),
// matching the two-step pattern used by sequences.ts and payments.ts.
// =============================================================================

export type CreateFifoLayerOnReceiveParams = {
  variantId: string;
  warehouseId: string;
  qtyReceived: Prisma.Decimal | string | number;
  unitCost: Prisma.Decimal | string | number;
  receivedDate: Date;
  sourceReceiptLineId: string;
  sourceMovementId: string;
};

export async function createFifoLayerOnReceiveTx(
  tx: Prisma.TransactionClient,
  params: CreateFifoLayerOnReceiveParams,
  ctx?: AuditContext,
): Promise<FifoLayer> {
  const qtyReceived = new Prisma.Decimal(params.qtyReceived);
  const unitCost = new Prisma.Decimal(params.unitCost);

  // Defensive — the CHECK constraint will catch this at COMMIT, but a
  // friendly TS-level error is cheaper to debug than a Postgres CHECK
  // violation thrown from inside an FK-tangled transaction.
  if (qtyReceived.lessThanOrEqualTo(0)) {
    throw new Error(
      `createFifoLayerOnReceiveTx: qtyReceived must be > 0 (got ${qtyReceived.toString()})`,
    );
  }
  if (unitCost.lessThan(0)) {
    throw new Error(
      `createFifoLayerOnReceiveTx: unitCost must be >= 0 (got ${unitCost.toString()})`,
    );
  }

  const layer = await tx.fifoLayer.create({
    data: {
      variantId: params.variantId,
      warehouseId: params.warehouseId,
      qtyReceived,
      qtyConsumed: new Prisma.Decimal(0),
      qtyRemaining: qtyReceived,
      unitCost,
      receivedDate: params.receivedDate,
      sourceReceiptLineId: params.sourceReceiptLineId,
      sourceMovementId: params.sourceMovementId,
    },
  });

  await audit(tx, {
    action: AuditAction.CREATE,
    entityType: 'FifoLayer',
    entityId: layer.id,
    after: layer,
    ctx,
  });

  return layer;
}

export type ConsumeFromLayersParams = {
  variantId: string;
  warehouseId: string;
  qty: Prisma.Decimal | string | number;
  movementId: string;
};

export type ConsumeFromLayersResult = {
  consumptions: FifoConsumption[];
  weightedAverageCost: Prisma.Decimal | null;
  fullyAllocated: boolean;
};

export async function consumeFromLayersTx(
  tx: Prisma.TransactionClient,
  params: ConsumeFromLayersParams,
): Promise<ConsumeFromLayersResult> {
  const qty = new Prisma.Decimal(params.qty);
  if (qty.lessThanOrEqualTo(0)) {
    throw new Error(
      `consumeFromLayersTx: qty must be > 0 (got ${qty.toString()})`,
    );
  }

  // Step 1: lock candidate layer rows. Same WHERE clause as the typed
  // findMany below; FOR UPDATE serializes against any concurrent
  // consume / late-landed-cost flow that touches the same rows.
  await tx.$executeRaw`
    SELECT "id" FROM "FifoLayer"
    WHERE "variantId" = ${params.variantId}
      AND "warehouseId" = ${params.warehouseId}
      AND "deletedAt" IS NULL
      AND "qtyRemaining" > 0
    ORDER BY "receivedDate" ASC, "id" ASC
    FOR UPDATE
  `;

  // Step 2: typed read for the same set, ordered the same way.
  const layers = await tx.fifoLayer.findMany({
    where: {
      variantId: params.variantId,
      warehouseId: params.warehouseId,
      deletedAt: null,
      qtyRemaining: { gt: new Prisma.Decimal(0) },
    },
    orderBy: [{ receivedDate: 'asc' }, { id: 'asc' }],
  });

  if (layers.length === 0) {
    return {
      consumptions: [],
      weightedAverageCost: null,
      fullyAllocated: false,
    };
  }

  let remaining = qty;
  let totalAllocated = new Prisma.Decimal(0);
  let totalWeighted = new Prisma.Decimal(0);
  const consumptions: FifoConsumption[] = [];

  for (const layer of layers) {
    if (remaining.lessThanOrEqualTo(0)) break;

    const take = Prisma.Decimal.min(remaining, layer.qtyRemaining);
    const newConsumed = layer.qtyConsumed.plus(take);
    const newRemaining = layer.qtyRemaining.minus(take);

    await tx.fifoLayer.update({
      where: { id: layer.id },
      data: { qtyConsumed: newConsumed, qtyRemaining: newRemaining },
    });

    const consumption = await tx.fifoConsumption.create({
      data: {
        movementId: params.movementId,
        layerId: layer.id,
        qty: take,
        unitCost: layer.unitCost,
      },
    });
    consumptions.push(consumption);

    totalWeighted = totalWeighted.plus(take.times(layer.unitCost));
    totalAllocated = totalAllocated.plus(take);
    remaining = remaining.minus(take);
  }

  const weightedAverageCost = totalAllocated.greaterThan(0)
    ? totalWeighted.dividedBy(totalAllocated)
    : null;
  const fullyAllocated = remaining.lessThanOrEqualTo(0);

  return { consumptions, weightedAverageCost, fullyAllocated };
}

// Read-only helper for adjustment-loss flows in future parts (Part 3+).
// No FOR UPDATE — the caller (when one exists) should take the bin
// advisory lock and add its own row-level lock if it intends to mutate.
export async function getOldestLayer(
  tx: Prisma.TransactionClient,
  variantId: string,
  warehouseId: string,
): Promise<FifoLayer | null> {
  return tx.fifoLayer.findFirst({
    where: {
      variantId,
      warehouseId,
      deletedAt: null,
      qtyRemaining: { gt: new Prisma.Decimal(0) },
    },
    orderBy: [{ receivedDate: 'asc' }, { id: 'asc' }],
  });
}
