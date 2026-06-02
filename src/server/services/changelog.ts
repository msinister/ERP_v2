import { AuditAction, ChangelogEntryType, Prisma } from '@/generated/tenant';
import type { PrismaClient } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import type { Actor } from '@/lib/permissions/actor';

// =============================================================================
// Changelog service — published entries for users, full CRUD for admins.
//
// Draft = publishedAt IS NULL or publishedAt > now()
// Published = publishedAt <= now()
// =============================================================================

export type ChangelogEntryData = {
  version: string;
  title: string;
  description: string;
  type: ChangelogEntryType;
  publishedAt: Date | null;
};

/** All published entries, newest first. Excludes soft-deleted rows. */
export async function listPublishedEntries(db: PrismaClient) {
  return db.changelogEntry.findMany({
    where: {
      deletedAt: null,
      publishedAt: { not: null, lte: new Date() },
    },
    select: {
      id: true,
      version: true,
      title: true,
      description: true,
      type: true,
      publishedAt: true,
      createdAt: true,
    },
    orderBy: { publishedAt: 'desc' },
  });
}

/** All entries including drafts — for admin list. Excludes soft-deleted. */
export async function listEntriesForAdmin(db: PrismaClient) {
  return db.changelogEntry.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      version: true,
      title: true,
      description: true,
      type: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true, email: true } },
    },
    orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
  });
}

export async function createEntry(
  db: PrismaClient,
  actor: Actor,
  data: ChangelogEntryData,
  ctx: AuditContext,
) {
  const entry = await db.changelogEntry.create({
    data: {
      version: data.version.trim(),
      title: data.title.trim(),
      description: data.description,
      type: data.type,
      publishedAt: data.publishedAt,
      createdById: actor.id,
    },
  });
  await audit(db, {
    action: AuditAction.CREATE,
    entityType: 'ChangelogEntry',
    entityId: entry.id,
    after: { version: entry.version, title: entry.title },
    ctx,
  });
  return entry;
}

export async function updateEntry(
  db: PrismaClient,
  actor: Actor,
  id: string,
  data: ChangelogEntryData,
  ctx: AuditContext,
) {
  const before = await db.changelogEntry.findUniqueOrThrow({
    where: { id, deletedAt: null },
    select: { version: true, title: true, publishedAt: true },
  });
  const entry = await db.changelogEntry.update({
    where: { id },
    data: {
      version: data.version.trim(),
      title: data.title.trim(),
      description: data.description,
      type: data.type,
      publishedAt: data.publishedAt,
    },
  });
  await audit(db, {
    action: AuditAction.UPDATE,
    entityType: 'ChangelogEntry',
    entityId: id,
    before,
    after: { version: entry.version, title: entry.title },
    ctx,
  });
  return entry;
}

export async function deleteEntry(
  db: PrismaClient,
  id: string,
  ctx: AuditContext,
) {
  const before = await db.changelogEntry.findUniqueOrThrow({
    where: { id, deletedAt: null },
    select: { version: true, title: true },
  });
  await db.changelogEntry.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  await audit(db, {
    action: AuditAction.DELETE,
    entityType: 'ChangelogEntry',
    entityId: id,
    before,
    ctx,
  });
}

/** Upsert read receipts for a batch of entry IDs. */
export async function markAsRead(
  db: PrismaClient,
  userId: string,
  entryIds: string[],
) {
  if (entryIds.length === 0) return;
  await db.userChangelogRead.createMany({
    data: entryIds.map((changelogEntryId) => ({
      userId,
      changelogEntryId,
      readAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

/** Count published entries this user hasn't read yet. */
export async function getUnreadCount(
  db: PrismaClient,
  userId: string,
): Promise<number> {
  const now = new Date();
  const [published, readCount] = await Promise.all([
    db.changelogEntry.count({
      where: { deletedAt: null, publishedAt: { not: null, lte: now } },
    }),
    db.userChangelogRead.count({
      where: {
        userId,
        entry: { deletedAt: null, publishedAt: { not: null, lte: now } },
      },
    }),
  ]);
  return Math.max(0, published - readCount);
}
