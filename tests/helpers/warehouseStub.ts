import type { PrismaClient, Warehouse } from '@/generated/tenant';

// Test helper: upsert a Warehouse linked to the seeded 1310 Inventory
// account so close-flow tests can drive postCogsForInvoiceTx, which
// requires Warehouse.inventoryAccountId be set (Part 3 of the costing
// engine slice). Mirrors customerStub.ts — a focused single-purpose
// helper for a relation invariant tests need to satisfy.
//
// Pilot is single-warehouse → all test warehouses share account 1310;
// the GL slice will generalize to per-warehouse inventory accounts and
// tests can switch to passing accountCode in then. Until then, the
// hardcoded '1310' here matches the seed at add_gl_stub migration.
export async function upsertTestWarehouse(
  db: PrismaClient,
  args: { code: string; name: string },
): Promise<Warehouse> {
  return db.warehouse.upsert({
    where: { code: args.code },
    create: {
      code: args.code,
      name: args.name,
      inventoryAccount: { connect: { code: '1310' } },
    },
    update: {
      active: true,
      deletedAt: null,
      inventoryAccount: { connect: { code: '1310' } },
    },
  });
}
