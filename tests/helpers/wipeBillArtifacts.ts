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
  // Vendor credits not tied to bills (manual VCs from vendorCredits
  // tests) won't be reached via the bills bridge — sweep them
  // explicitly by vendor.
  await wipeVendorCreditArtifactsByVendor(db, vendorIds);
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
  // Sweep stand-alone vendor credits (no associated bill) for the
  // same prefix.
  const vendors = await db.vendor.findMany({
    where: { code: { startsWith: prefix } },
    select: { id: true },
  });
  await wipeVendorCreditArtifactsByVendor(db, vendors.map((v) => v.id));
}

async function wipeBillsByQuery(
  db: PrismaClient,
  where: Prisma.BillWhereInput,
): Promise<void> {
  // VendorCredits are scoped by vendor — same scope as bills here.
  // Walk back through the bills' vendorIds to find them. Done first so
  // VC apply rows don't FK-block bill cleanup.
  const billsForVendorScope = await db.bill.findMany({
    where,
    select: { vendorId: true },
  });
  const vendorIds = Array.from(new Set(billsForVendorScope.map((b) => b.vendorId)));
  if (vendorIds.length > 0) {
    await wipeVendorCreditArtifactsByVendor(db, vendorIds);
  }

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

  // Sweep any vendor credits (and their JEs/applications/audit) that
  // may have been auto-created from bill payments OR that the test
  // created directly. wipeBillsByQuery already invoked this above for
  // the scoped vendors; this second pass catches any VC whose source
  // bill got wiped first. No-op if vendors have no VCs.
  const remainingBills = await db.bill.findMany({
    where: { id: { in: billIds } },
    select: { vendorId: true },
  });
  // After deleteMany above, remainingBills should be empty — but the
  // vendor scope is captured up front in wipeBillsByQuery's lead-in
  // call, so we don't need to re-scope here.
  void remainingBills;
}

async function wipeVendorCreditArtifactsByVendor(
  db: PrismaClient,
  vendorIds: string[],
): Promise<void> {
  if (vendorIds.length === 0) return;
  const vcs = await db.vendorCredit.findMany({
    where: { vendorId: { in: vendorIds } },
    select: { id: true },
  });
  if (vcs.length === 0) return;
  const vcIds = vcs.map((v) => v.id);

  const jes = await db.journalEntry.findMany({
    where: { entityType: 'VendorCredit', entityId: { in: vcIds } },
    select: { id: true },
  });
  if (jes.length > 0) {
    const jeIds = jes.map((j) => j.id);
    await db.journalEntryLine.deleteMany({
      where: { journalEntryId: { in: jeIds } },
    });
    await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
  }
  // Application audit rows are keyed by VendorCreditApplication ids —
  // collect those before deleting the apps.
  const apps = await db.vendorCreditApplication.findMany({
    where: { vendorCreditId: { in: vcIds } },
    select: { id: true },
  });
  const appIds = apps.map((a) => a.id);
  if (appIds.length > 0) {
    await db.auditLog.deleteMany({
      where: { entityType: 'VendorCreditApplication', entityId: { in: appIds } },
    });
  }
  await db.vendorCreditApplication.deleteMany({
    where: { vendorCreditId: { in: vcIds } },
  });
  await db.vendorCreditLine.deleteMany({
    where: { vendorCreditId: { in: vcIds } },
  });
  await db.auditLog.deleteMany({
    where: { entityType: 'VendorCredit', entityId: { in: vcIds } },
  });
  await db.vendorCredit.deleteMany({ where: { id: { in: vcIds } } });
}
