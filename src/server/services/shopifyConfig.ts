import { Prisma, type PrismaClient } from '@/generated/tenant';
import { decrypt, encrypt } from '@/lib/crypto';
import type { ShopifyConfigInput } from '@/lib/validation/shopify';

// =============================================================================
// Shopify integration config — get/save/decrypt helpers. The value lives
// in Setting (key 'shopify.config') as a JSON blob; the accessToken and
// webhookSecret are AES-256-GCM encrypted before they reach the column,
// stored as {ciphertext, iv} sub-objects per the lib/crypto contract.
//
// Public surface intentionally narrow:
//   - getPublicConfig: safe-to-render shape (no secrets), feeds the
//     admin form's defaultValues + the badge on the product detail.
//   - getSecrets: returns cleartext accessToken/webhookSecret, used only
//     by the sync service + webhook routes + test-connection.
//   - saveConfig: upsert the row, encrypt new secrets, preserve existing
//     ones when the form omits them ("leave alone" semantics).
//   - recordSyncRun + recordWebhookSubscriptions: append-style updates to
//     the same JSON blob (avoids a new model for run-log / subscription
//     bookkeeping).
// =============================================================================

const KEY = 'shopify.config';

type Encrypted = { ciphertext: string; iv: string };

// Stored shape. NEVER returned directly to the client — getPublicConfig
// strips the encrypted fields.
type StoredConfig = {
  storeUrl: string;
  accessToken: Encrypted | null;
  webhookSecret: Encrypted | null;
  syncEnabled: boolean;
  lastFullSyncAt: string | null;
  lastSync: StoredSyncRun | null;
  // Webhook ids returned by Shopify on register; tracked here so the
  // "are we wired up?" check + future unregister doesn't need a new
  // model. Topic → subscription id.
  webhookSubscriptions: Record<string, string> | null;
};

export type StoredSyncRun = {
  startedAt: string;
  finishedAt: string;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ shopifyId: string; message: string }>;
};

export type ShopifyPublicConfig = {
  storeUrl: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  syncEnabled: boolean;
  lastFullSyncAt: string | null;
  lastSync: StoredSyncRun | null;
  webhookSubscriptions: Record<string, string> | null;
};

const EMPTY: StoredConfig = {
  storeUrl: '',
  accessToken: null,
  webhookSecret: null,
  syncEnabled: false,
  lastFullSyncAt: null,
  lastSync: null,
  webhookSubscriptions: null,
};

async function readStored(db: PrismaClient): Promise<StoredConfig> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (!row) return EMPTY;
  const v = row.value as Partial<StoredConfig> | null;
  return { ...EMPTY, ...(v ?? {}) };
}

async function writeStored(
  db: PrismaClient,
  next: StoredConfig,
  userId: string | null,
): Promise<void> {
  // Prisma's Json input type doesn't accept a plain Record — round-trip
  // through JSON.parse so the inferred shape is the structural JsonValue
  // tree Prisma wants.
  const valueJson = JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue;
  await db.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: valueJson, updatedBy: userId },
    update: { value: valueJson, updatedBy: userId },
  });
}

export async function getPublicConfig(
  db: PrismaClient,
): Promise<ShopifyPublicConfig> {
  const c = await readStored(db);
  return {
    storeUrl: c.storeUrl,
    hasAccessToken: c.accessToken != null,
    hasWebhookSecret: c.webhookSecret != null,
    syncEnabled: c.syncEnabled,
    lastFullSyncAt: c.lastFullSyncAt,
    lastSync: c.lastSync,
    webhookSubscriptions: c.webhookSubscriptions,
  };
}

export async function saveConfig(
  db: PrismaClient,
  input: ShopifyConfigInput,
  userId: string | null,
): Promise<ShopifyPublicConfig> {
  const prev = await readStored(db);
  const next: StoredConfig = {
    ...prev,
    storeUrl: input.storeUrl,
    syncEnabled: input.syncEnabled,
    // "Omitted on PUT" means keep the existing secret — admins shouldn't
    // have to re-paste tokens every time they toggle syncEnabled.
    accessToken:
      input.accessToken != null ? encrypt(input.accessToken) : prev.accessToken,
    webhookSecret:
      input.webhookSecret != null
        ? encrypt(input.webhookSecret)
        : prev.webhookSecret,
  };
  await writeStored(db, next, userId);
  return getPublicConfig(db);
}

export type ShopifySecrets = {
  storeUrl: string;
  accessToken: string;
  webhookSecret: string;
};

/**
 * Decrypt + return cleartext secrets. Throws if config is missing/incomplete —
 * the caller (sync service, webhook handler) treats that as "Shopify not
 * configured yet" and short-circuits.
 */
export async function getSecrets(db: PrismaClient): Promise<ShopifySecrets> {
  const c = await readStored(db);
  if (!c.storeUrl || !c.accessToken || !c.webhookSecret) {
    throw new Error('Shopify is not fully configured');
  }
  return {
    storeUrl: c.storeUrl,
    accessToken: decrypt(c.accessToken.ciphertext, c.accessToken.iv),
    webhookSecret: decrypt(c.webhookSecret.ciphertext, c.webhookSecret.iv),
  };
}

/** Webhook secret alone — webhook handlers don't need the access token. */
export async function getWebhookSecret(db: PrismaClient): Promise<string | null> {
  const c = await readStored(db);
  if (!c.webhookSecret) return null;
  return decrypt(c.webhookSecret.ciphertext, c.webhookSecret.iv);
}

export async function isSyncEnabled(db: PrismaClient): Promise<boolean> {
  const c = await readStored(db);
  return c.syncEnabled;
}

export async function recordSyncRun(
  db: PrismaClient,
  run: StoredSyncRun,
  userId: string | null,
): Promise<void> {
  const prev = await readStored(db);
  await writeStored(
    db,
    { ...prev, lastFullSyncAt: run.finishedAt, lastSync: run },
    userId,
  );
}

export async function recordWebhookSubscriptions(
  db: PrismaClient,
  subs: Record<string, string>,
  userId: string | null,
): Promise<void> {
  const prev = await readStored(db);
  await writeStored(db, { ...prev, webhookSubscriptions: subs }, userId);
}
