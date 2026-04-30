import type { Customer, PrismaClient } from '@/generated/tenant';

// Test helper: upsert a Customer that satisfies the post-master-expansion
// required relations (salesRep + paymentTerm). Connects to the rows seeded
// by the expand_customer_master migration: UNASSIGNED sales rep + NET30
// payment term. Tests that just need a customer FK target use this.
export async function upsertTestCustomer(
  db: PrismaClient,
  args: { code: string; name: string },
): Promise<Customer> {
  return db.customer.upsert({
    where: { code: args.code },
    create: {
      code: args.code,
      name: args.name,
      salesRep: { connect: { code: 'UNASSIGNED' } },
      paymentTerm: { connect: { code: 'NET30' } },
    },
    update: { active: true, deletedAt: null },
  });
}
