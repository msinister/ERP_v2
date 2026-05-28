import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { AuditAction, Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { AuditLogFilters, type UserOption } from './_components/filters';
import { AuditLogTable, type AuditRowData } from './_components/table';
import { AuditLogPagination } from './_components/pagination';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function isAuditAction(v: string | undefined): v is AuditAction {
  if (!v) return false;
  return Object.values(AuditAction).includes(v as AuditAction);
}

function parseDateInput(
  v: string | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePagePermission('admin.view_audit_log');

  const sp = await searchParams;
  const entityType = pickString(sp.entityType);
  const entityId = pickString(sp.entityId);
  const userIdFilter = pickString(sp.userId);
  const actionRaw = pickString(sp.action);
  const action = isAuditAction(actionRaw) ? actionRaw : undefined;
  const dateFrom = parseDateInput(pickString(sp.from), false);
  const dateTo = parseDateInput(pickString(sp.to), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  // entityType is treated as a prefix match (case-insensitive) so a
  // partial like "Bill" surfaces Bill + BillPayment + BillReceipt
  // rows without forcing the operator to know the exact entity name.
  const where: Prisma.AuditLogWhereInput = {
    ...(entityType
      ? { entityType: { startsWith: entityType, mode: 'insensitive' as const } }
      : {}),
    ...(entityId ? { entityId } : {}),
    ...(userIdFilter ? { userId: userIdFilter } : {}),
    ...(action ? { action } : {}),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
  };

  const [rawRows, total, users] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    db.auditLog.count({ where }),
    // Active + disabled users both surface — historical entries can
    // reference disabled accounts and we want to label them anyway.
    db.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  ]);

  // Resolve userId → user display info in one batched fetch, then
  // map onto each audit row. AuditLog.userId is nullable + has no FK
  // (intentional — audit must survive a user hard-delete), so a
  // missing id is a system-attributed entry, not an error.
  const usersById = new Map(users.map((u) => [u.id, u]));
  const tableRows: AuditRowData[] = rawRows.map((row) => {
    const u = row.userId ? usersById.get(row.userId) : null;
    return {
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      userName: u?.name ?? null,
      userEmail: u?.email ?? null,
      ipAddress: row.ipAddress,
      reason: row.reason,
      beforeJson: row.beforeJson,
      afterJson: row.afterJson,
      createdAt: row.createdAt,
    };
  });

  const userOptions: UserOption[] = users.map((u) => ({
    id: u.id,
    label: `${u.name} (${u.email})`,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Append-only history of sensitive actions. Click a row to view
            the full before / after JSON. Filter by entity, action, user,
            or date range.
          </p>
        </div>
      </div>

      <AuditLogFilters users={userOptions} />

      <AuditLogTable rows={tableRows} />

      <AuditLogPagination total={total} skip={skip} take={take} />
    </div>
  );
}
