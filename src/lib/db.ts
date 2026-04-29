import { PrismaClient } from '@/generated/tenant';                                                                                                                                                                                              
  declare global {
    var __prisma: PrismaClient | undefined;
  }

  export const db: PrismaClient =
    globalThis.__prisma ?? new PrismaClient();

  if (process.env.NODE_ENV !== 'production') {
    globalThis.__prisma = db;
  }
