import type { PrismaClient, Vendor } from '@/generated/tenant';

// Test helper: upsert a Vendor that satisfies the post-master-expansion
// schema. The new Vendor model has additional nullable columns (type
// defaults to STOCK, paymentTermId is nullable on the model so legacy
// upserts continue to work) — this helper keeps the pattern consistent
// for tests that need a vendor FK target without exercising the master
// service.
//
// For tests that exercise the actual createVendor service, do not use
// this helper — call `createVendor` directly with a paymentTermId.
export async function upsertTestVendor(
  db: PrismaClient,
  args: { code: string; name: string },
): Promise<Vendor> {
  return db.vendor.upsert({
    where: { code: args.code },
    create: { code: args.code, name: args.name },
    update: { active: true, deletedAt: null },
  });
}
