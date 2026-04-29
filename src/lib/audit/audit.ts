import { Prisma } from '@/generated/tenant';
import type { AuditAction, PrismaClient } from '@/generated/tenant';

export type AuditClient = PrismaClient | Prisma.TransactionClient;

export type AuditContext = {
  userId?: string | null;
  ipAddress?: string | null;
  reason?: string | null;
};

export type AuditArgs = {
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ctx?: AuditContext;
};

// Prisma's Json input type rejects `undefined` and arbitrary objects need to
// pass through JSON.stringify/parse so Decimal, Date, BigInt etc. land as
// JSON-safe primitives. Returning Prisma.JsonNull for `undefined`/`null` keeps
// the column explicit (NULL) rather than the literal JSON `null` token.
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function audit(
  client: AuditClient,
  args: AuditArgs,
): Promise<void> {
  await client.auditLog.create({
    data: {
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      beforeJson: toJson(args.before),
      afterJson: toJson(args.after),
      userId: args.ctx?.userId ?? null,
      ipAddress: args.ctx?.ipAddress ?? null,
      reason: args.ctx?.reason ?? null,
    },
  });
}
