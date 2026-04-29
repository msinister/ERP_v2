import { PrismaClient } from '@/generated/tenant';

export function makeClient(): PrismaClient {
  return new PrismaClient();
}

export const hasTenantDb = !!process.env.TENANT_DATABASE_URL;
