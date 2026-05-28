import { PrismaClient } from '../src/generated/tenant';
const db = new PrismaClient({ datasourceUrl: process.env.TENANT_DATABASE_URL });
async function main() {
  const reviews = await db.pendingOrderReview.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log('Reviews:', JSON.stringify(reviews.map(r => ({
    id: r.id, status: r.status, reason: r.reason,
    shopifyOrderId: r.shopifyOrderId, shopifyOrderNumber: r.shopifyOrderNumber,
  })), null, 2));

  const sos = await db.salesOrder.findMany({
    where: { shopifyOrderId: { not: null } },
    select: { id: true, number: true, shopifyOrderId: true, deletedAt: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log('Shopify SOs:', JSON.stringify(sos, null, 2));
  await db.$disconnect();
}
main().catch(console.error);
