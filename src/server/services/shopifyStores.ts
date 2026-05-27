import { Prisma, AuditAction } from '@/generated/tenant';
import type { PrismaClient, ShopifyStore } from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  shopifyStoreCreateSchema,
  shopifyStoreUpdateSchema,
  type ShopifyStoreCreateInput,
  type ShopifyStoreUpdateInput,
} from '@/lib/validation/shopifyStores';

// =============================================================================
// ShopifyStore CRUD + secret access. Replaces the legacy single-store
// shopifyConfig.ts. Secrets (accessToken, webhookSecret) are AES-256-GCM
// encrypted via lib/crypto before they reach the Json column. The public
// shape never leaks ciphertext; getSecretsForStore is the only path that
// returns cleartext and is reserved for sync + webhook + test-connection
// callers.
//
// Run-history bookkeeping (recordSyncRun, recordPushRun, recordWebhook
// Subscriptions) mutates the per-store Json blobs in-place rather than
// promoting them to dedicated tables. Matches the legacy pattern; if/when
// these grow into rich audit needs they can be promoted.
// =============================================================================

type Encrypted = { ciphertext: string; iv: string };

function decryptStored(v: Prisma.JsonValue | null): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const ciphertext = typeof obj.ciphertext === 'string' ? obj.ciphertext : null;
  const iv = typeof obj.iv === 'string' ? obj.iv : null;
  if (!ciphertext || !iv) return null;
  return decrypt(ciphertext, iv);
}

function encryptedToJson(enc: Encrypted): Prisma.InputJsonValue {
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export type ShopifyStorePublic = {
  id: string;
  name: string;
  storeUrl: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  syncEnabled: boolean;
  inventoryPushEnabled: boolean;
  shopifyLocationId: string | null;
  lastProductSyncAt: Date | null;
  lastInventoryPushAt: Date | null;
  lastSyncResult: Prisma.JsonValue | null;
  lastPushResult: Prisma.JsonValue | null;
  webhookSubscriptionIds: Prisma.JsonValue | null;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toPublic(s: ShopifyStore): ShopifyStorePublic {
  return {
    id: s.id,
    name: s.name,
    storeUrl: s.storeUrl,
    hasAccessToken: s.accessToken != null,
    hasWebhookSecret: s.webhookSecret != null,
    syncEnabled: s.syncEnabled,
    inventoryPushEnabled: s.inventoryPushEnabled,
    shopifyLocationId: s.shopifyLocationId,
    lastProductSyncAt: s.lastProductSyncAt,
    lastInventoryPushAt: s.lastInventoryPushAt,
    lastSyncResult: s.lastSyncResult,
    lastPushResult: s.lastPushResult,
    webhookSubscriptionIds: s.webhookSubscriptionIds,
    sortOrder: s.sortOrder,
    active: s.active,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export async function listStores(
  db: PrismaClient,
  opts?: { includeArchived?: boolean },
): Promise<ShopifyStorePublic[]> {
  const rows = await db.shopifyStore.findMany({
    where: opts?.includeArchived ? {} : { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toPublic);
}

export async function getStore(
  db: PrismaClient,
  id: string,
): Promise<ShopifyStorePublic | null> {
  const row = await db.shopifyStore.findUnique({ where: { id } });
  if (!row) return null;
  return toPublic(row);
}

/** Lookup by canonical bare host — used by the webhook router. */
export async function getStoreByUrl(
  db: PrismaClient,
  storeUrl: string,
): Promise<ShopifyStore | null> {
  return db.shopifyStore.findUnique({ where: { storeUrl } });
}

/**
 * Used by the legacy admin UI page (Slice A) and any caller that needs "the"
 * store before multi-store UI exists. Returns the first active, non-archived
 * store by sortOrder. Null if none.
 *
 * Slice B will retire this in favor of explicit storeId routing in the UI.
 */
export async function getDefaultStore(
  db: PrismaClient,
): Promise<ShopifyStorePublic | null> {
  const row = await db.shopifyStore.findFirst({
    where: { active: true, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return row ? toPublic(row) : null;
}

export async function createStore(
  db: PrismaClient,
  input: ShopifyStoreCreateInput,
  ctx?: AuditContext,
): Promise<ShopifyStorePublic> {
  const data = shopifyStoreCreateSchema.parse(input);
  return db.$transaction(async (tx) => {
    // Auto-append to the end of the list when sortOrder is omitted.
    // max(sortOrder) + 10 leaves room for manual reordering later without
    // requiring a full renumber.
    let sortOrder = data.sortOrder;
    if (sortOrder == null) {
      const max = await tx.shopifyStore.aggregate({ _max: { sortOrder: true } });
      sortOrder = (max._max.sortOrder ?? -10) + 10;
    }
    const store = await tx.shopifyStore.create({
      data: {
        name: data.name,
        storeUrl: data.storeUrl,
        accessToken: data.accessToken
          ? encryptedToJson(encrypt(data.accessToken))
          : Prisma.DbNull,
        webhookSecret: data.webhookSecret
          ? encryptedToJson(encrypt(data.webhookSecret))
          : Prisma.DbNull,
        syncEnabled: data.syncEnabled,
        inventoryPushEnabled: data.inventoryPushEnabled,
        shopifyLocationId: data.shopifyLocationId ?? null,
        sortOrder,
        active: data.active,
        createdBy: ctx?.userId ?? null,
        updatedBy: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'ShopifyStore',
      entityId: store.id,
      after: { ...store, accessToken: null, webhookSecret: null },
      ctx,
    });
    return toPublic(store);
  });
}

export async function updateStore(
  db: PrismaClient,
  id: string,
  input: ShopifyStoreUpdateInput,
  ctx?: AuditContext,
): Promise<ShopifyStorePublic> {
  const data = shopifyStoreUpdateSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.shopifyStore.findUnique({ where: { id } });
    if (!before) throw new Error(`ShopifyStore not found: ${id}`);

    // Preserve-vs-replace: undefined/empty token → keep current value;
    // a non-empty string → re-encrypt with a fresh IV.
    const accessToken =
      data.accessToken != null
        ? encryptedToJson(encrypt(data.accessToken))
        : undefined;
    const webhookSecret =
      data.webhookSecret != null
        ? encryptedToJson(encrypt(data.webhookSecret))
        : undefined;

    const after = await tx.shopifyStore.update({
      where: { id },
      data: {
        name: data.name,
        storeUrl: data.storeUrl,
        accessToken,
        webhookSecret,
        syncEnabled: data.syncEnabled,
        inventoryPushEnabled: data.inventoryPushEnabled,
        shopifyLocationId: data.shopifyLocationId,
        sortOrder: data.sortOrder,
        active: data.active,
        updatedBy: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'ShopifyStore',
      entityId: id,
      before: { ...before, accessToken: null, webhookSecret: null },
      after: { ...after, accessToken: null, webhookSecret: null },
      ctx,
    });
    return toPublic(after);
  });
}

export async function archiveStore(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.shopifyStore.findUnique({ where: { id } });
    if (!before) throw new Error(`ShopifyStore not found: ${id}`);
    if (before.deletedAt != null) return;
    const after = await tx.shopifyStore.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        active: false,
        syncEnabled: false,
        inventoryPushEnabled: false,
        updatedBy: ctx?.userId ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'ShopifyStore',
      entityId: id,
      before: { ...before, accessToken: null, webhookSecret: null },
      after: { ...after, accessToken: null, webhookSecret: null },
      ctx,
    });
  });
}

// ---------------------------------------------------------------------------
// Secret access — reserved for sync / webhook / test-connection callers.
// ---------------------------------------------------------------------------

export type ShopifyStoreSecrets = {
  storeId: string;
  name: string;
  storeUrl: string;
  accessToken: string;
  webhookSecret: string;
  syncEnabled: boolean;
  inventoryPushEnabled: boolean;
  shopifyLocationId: string | null;
};

/**
 * Decrypt + return secrets for one store. Throws if the store is missing,
 * archived, or its secrets are incomplete — the caller treats that as
 * "Shopify not configured for this store" and short-circuits.
 */
export async function getSecretsForStore(
  db: PrismaClient,
  storeId: string,
): Promise<ShopifyStoreSecrets> {
  const s = await db.shopifyStore.findUnique({ where: { id: storeId } });
  if (!s) throw new Error(`ShopifyStore not found: ${storeId}`);
  if (s.deletedAt != null) {
    throw new Error(`ShopifyStore is archived: ${storeId}`);
  }
  const accessToken = decryptStored(s.accessToken);
  const webhookSecret = decryptStored(s.webhookSecret);
  if (!s.storeUrl || !accessToken || !webhookSecret) {
    throw new Error(`ShopifyStore ${storeId} is not fully configured`);
  }
  return {
    storeId: s.id,
    name: s.name,
    storeUrl: s.storeUrl,
    accessToken,
    webhookSecret,
    syncEnabled: s.syncEnabled,
    inventoryPushEnabled: s.inventoryPushEnabled,
    shopifyLocationId: s.shopifyLocationId,
  };
}

/** Webhook secret alone — webhook handlers don't need the access token. */
export async function getWebhookSecretForStore(
  db: PrismaClient,
  storeId: string,
): Promise<string | null> {
  const s = await db.shopifyStore.findUnique({
    where: { id: storeId },
    select: { webhookSecret: true },
  });
  if (!s) return null;
  return decryptStored(s.webhookSecret);
}

// ---------------------------------------------------------------------------
// Run-history + webhook subscription bookkeeping. Mirror the legacy shape.
// ---------------------------------------------------------------------------

export type StoredSyncRun = {
  startedAt: string;
  finishedAt: string;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ shopifyId: string; message: string }>;
};

export type StoredPushRun = {
  startedAt: string;
  finishedAt: string;
  pushed: number;
  skipped: number;
  errors: Array<{ productId: string; storeId: string; message: string }>;
};

export async function recordSyncRun(
  db: PrismaClient,
  storeId: string,
  run: StoredSyncRun,
): Promise<void> {
  await db.shopifyStore.update({
    where: { id: storeId },
    data: {
      lastProductSyncAt: new Date(run.finishedAt),
      lastSyncResult: JSON.parse(JSON.stringify(run)) as Prisma.InputJsonValue,
    },
  });
}

export async function recordPushRun(
  db: PrismaClient,
  storeId: string,
  run: StoredPushRun,
): Promise<void> {
  await db.shopifyStore.update({
    where: { id: storeId },
    data: {
      lastInventoryPushAt: new Date(run.finishedAt),
      lastPushResult: JSON.parse(JSON.stringify(run)) as Prisma.InputJsonValue,
    },
  });
}

export async function recordWebhookSubscriptions(
  db: PrismaClient,
  storeId: string,
  subs: Record<string, string>,
): Promise<void> {
  await db.shopifyStore.update({
    where: { id: storeId },
    data: {
      webhookSubscriptionIds: JSON.parse(
        JSON.stringify(subs),
      ) as Prisma.InputJsonValue,
    },
  });
}
