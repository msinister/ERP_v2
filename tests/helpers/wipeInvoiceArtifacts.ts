import type { PrismaClient } from '@/generated/tenant';

/**
 * Clean up Invoice + JournalEntry + audit artifacts that may have
 * been created as a side effect of closeSalesOrder. Call this from a
 * test's `wipe()` helper BEFORE deleting SalesOrders, since
 * Invoice.salesOrderId has ON DELETE RESTRICT.
 *
 * Scoped by salesOrderId list — pass the SOs you're about to delete.
 */
export async function wipeInvoiceArtifactsForSOs(
  db: PrismaClient,
  salesOrderIds: string[],
): Promise<void> {
  if (salesOrderIds.length === 0) return;
  const invoices = await db.invoice.findMany({
    where: { salesOrderId: { in: salesOrderIds } },
    select: { id: true },
  });
  if (invoices.length === 0) return;
  const invoiceIds = invoices.map((i) => i.id);
  // Invoice JEs (entity entries created by generateInvoiceForClosedSO + voids).
  const jes = await db.journalEntry.findMany({
    where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
    select: { id: true },
  });
  if (jes.length > 0) {
    const jeIds = jes.map((j) => j.id);
    await db.journalEntryLine.deleteMany({ where: { journalEntryId: { in: jeIds } } });
    await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
  }
  // Audit rows for invoices.
  await db.auditLog.deleteMany({
    where: { entityType: 'Invoice', entityId: { in: invoiceIds } },
  });
  // CreditApplication rows for these invoices (in case any tests applied).
  await db.creditApplication.deleteMany({
    where: { invoiceId: { in: invoiceIds } },
  });
  // Invoice lines + invoices themselves.
  await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
}
