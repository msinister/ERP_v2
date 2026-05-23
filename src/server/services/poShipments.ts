import { AuditAction, Prisma } from '@/generated/tenant';
import type { PoShipment, PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  createPoShipmentInputSchema,
  updatePoShipmentInputSchema,
  type CreatePoShipmentInput,
  type UpdatePoShipmentInput,
} from '@/lib/validation/purchasing';

// =============================================================================
// PoShipment service. Physical-logistics tracking layered on a PO — many
// shipments per PO, each carrying carrier / tracking / ETA + a status
// (PAID → IN_PRODUCTION → IN_TRANSIT → DELIVERED). No GL or inventory
// effect; receiving stays the Receipt flow.
//
// Soft-delete (deletedAt) per the project-wide rule — "remove a shipment"
// hides it from live views but preserves history. Audit via the audit()
// helper with entityType 'PoShipment' (model-name convention).
// =============================================================================

const ENTITY = 'PoShipment';

async function getLivePoOrThrow(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
): Promise<void> {
  const po = await tx.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, deletedAt: null },
    select: { id: true },
  });
  if (!po) throw new Error(`PurchaseOrder not found: ${purchaseOrderId}`);
}

// Normalize a nullable-optional field for a Prisma create:
//   undefined → null (column accepts null), null → null, value → value.
function nullable<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

export async function createPoShipment(
  db: PrismaClient,
  purchaseOrderId: string,
  input: CreatePoShipmentInput,
  ctx?: AuditContext,
): Promise<PoShipment> {
  const data = createPoShipmentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    await getLivePoOrThrow(tx, purchaseOrderId);
    const shipment = await tx.poShipment.create({
      data: {
        purchaseOrderId,
        shipmentStatus: data.shipmentStatus,
        trackingNumber: nullable(data.trackingNumber),
        carrierName: nullable(data.carrierName),
        trackingUrl: nullable(data.trackingUrl),
        cartonCount: nullable(data.cartonCount),
        totalWeight:
          data.totalWeight != null ? new Prisma.Decimal(data.totalWeight) : null,
        // weightUnit has a schema default ("lbs"); honor an explicit value.
        ...(data.weightUnit !== undefined ? { weightUnit: data.weightUnit } : {}),
        estimatedArrival: nullable(data.estimatedArrival),
        notes: nullable(data.notes),
        createdById: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: ENTITY,
      entityId: shipment.id,
      after: shipment,
      ctx,
    });
    return shipment;
  });
}

export async function updatePoShipment(
  db: PrismaClient,
  purchaseOrderId: string,
  shipmentId: string,
  input: UpdatePoShipmentInput,
  ctx?: AuditContext,
): Promise<PoShipment> {
  const data = updatePoShipmentInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.poShipment.findUnique({ where: { id: shipmentId } });
    if (!before || before.deletedAt) {
      throw new Error(`PoShipment not found: ${shipmentId}`);
    }
    if (before.purchaseOrderId !== purchaseOrderId) {
      throw new Error(
        `Shipment ${shipmentId} does not belong to PurchaseOrder ${purchaseOrderId}`,
      );
    }

    // Build the update from only the fields the caller supplied. Each is
    // optional; a present `null` clears the column.
    const updateData: Prisma.PoShipmentUpdateInput = {};
    if (data.shipmentStatus !== undefined) updateData.shipmentStatus = data.shipmentStatus;
    if (data.trackingNumber !== undefined) updateData.trackingNumber = data.trackingNumber;
    if (data.carrierName !== undefined) updateData.carrierName = data.carrierName;
    if (data.trackingUrl !== undefined) updateData.trackingUrl = data.trackingUrl;
    if (data.cartonCount !== undefined) updateData.cartonCount = data.cartonCount;
    if (data.totalWeight !== undefined) {
      updateData.totalWeight =
        data.totalWeight != null ? new Prisma.Decimal(data.totalWeight) : null;
    }
    if (data.weightUnit !== undefined) updateData.weightUnit = data.weightUnit;
    if (data.estimatedArrival !== undefined) {
      updateData.estimatedArrival = data.estimatedArrival;
    }
    if (data.notes !== undefined) updateData.notes = data.notes;

    if (Object.keys(updateData).length === 0) {
      throw new Error('No fields to update');
    }

    const after = await tx.poShipment.update({
      where: { id: shipmentId },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: ENTITY,
      entityId: shipmentId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeletePoShipment(
  db: PrismaClient,
  purchaseOrderId: string,
  shipmentId: string,
  ctx?: AuditContext,
): Promise<PoShipment> {
  return db.$transaction(async (tx) => {
    const before = await tx.poShipment.findUnique({ where: { id: shipmentId } });
    if (!before || before.deletedAt) {
      throw new Error(`PoShipment not found: ${shipmentId}`);
    }
    if (before.purchaseOrderId !== purchaseOrderId) {
      throw new Error(
        `Shipment ${shipmentId} does not belong to PurchaseOrder ${purchaseOrderId}`,
      );
    }
    const after = await tx.poShipment.update({
      where: { id: shipmentId },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: ENTITY,
      entityId: shipmentId,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function listPoShipments(
  db: PrismaClient,
  purchaseOrderId: string,
): Promise<PoShipment[]> {
  return db.poShipment.findMany({
    where: { purchaseOrderId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}
