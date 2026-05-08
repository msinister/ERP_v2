import type { Prisma, PrismaClient } from '@/generated/tenant';

// Test cleanup helper: tear down Bill artifacts (bills, lines, join
// rows, JEs, audit) before deleting the parent vendors / variants /
// receipts. Required because:
//   * BillLine.variantId + BillLine.expenseAccountId are RESTRICT FKs
//     (a SET NULL would violate BillLine_source_xor CHECK).
//   * Bill.vendorId is RESTRICT.
//   * BillReceipt + BillPurchaseOrder cascade on join, but Bill itself
//     remains.
//
// As of phase 8 slice C, postReceipt auto-creates a DRAFT bill —
// which means EVERY test that posts a receipt now produces a Bill row
// pointing at its vendor. Tests that hard-delete vendors / variants /
// products in afterAll() must call this helper first.
//
// Scope by vendorId list (works for tests using upsertTestVendor with
// stable codes, and for tests that maintain their own vendorId).

export async function wipeBillArtifactsForVendors(
  db: PrismaClient,
  vendorIds: string[],
): Promise<void> {
  if (vendorIds.length === 0) return;
  await wipeBillsByQuery(db, { vendorId: { in: vendorIds } });
}

/**
 * Variant scoped by vendor-code prefix — for tests whose `wipe` is
 * module-level and can't see the closure's vendorId(s) directly.
 */
export async function wipeBillArtifactsForVendorCodePrefix(
  db: PrismaClient,
  prefix: string,
): Promise<void> {
  if (!prefix) return;
  await wipeBillsByQuery(db, { vendor: { code: { startsWith: prefix } } });
}

async function wipeBillsByQuery(
  db: PrismaClient,
  where: Prisma.BillWhereInput,
): Promise<void> {
  const bills = await db.bill.findMany({ where, select: { id: true } });
  if (bills.length === 0) return;
  const billIds = bills.map((b) => b.id);

  // Bill JEs (any CONFIRMED bills carry confirm + possibly cancel JEs).
  const jes = await db.journalEntry.findMany({
    where: { entityType: 'Bill', entityId: { in: billIds } },
    select: { id: true },
  });
  if (jes.length > 0) {
    const jeIds = jes.map((j) => j.id);
    await db.journalEntryLine.deleteMany({
      where: { journalEntryId: { in: jeIds } },
    });
    await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
  }

  // Vendor-credit applications pointing at these bills (when slice D
  // ships). VendorCreditApplication.billId is RESTRICT.
  await db.vendorCreditApplication.deleteMany({
    where: { billId: { in: billIds } },
  });

  // Bill payments (when slice D ships). BillPayment.billId is RESTRICT.
  await db.billPayment.deleteMany({ where: { billId: { in: billIds } } });

  // Join rows (cascade-on-bill-delete would also handle these, but
  // explicit is faster and avoids a round-trip).
  await db.billReceipt.deleteMany({ where: { billId: { in: billIds } } });
  await db.billPurchaseOrder.deleteMany({ where: { billId: { in: billIds } } });

  // Lines (RESTRICT on variantId means we MUST delete lines before any
  // variant cleanup downstream).
  await db.billLine.deleteMany({ where: { billId: { in: billIds } } });

  await db.auditLog.deleteMany({
    where: { entityType: 'Bill', entityId: { in: billIds } },
  });
  await db.bill.deleteMany({ where: { id: { in: billIds } } });
}
