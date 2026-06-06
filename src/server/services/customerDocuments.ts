import {
  AuditAction,
  CustomerActivityKind,
  CustomerDocumentKind,
  Prisma,
} from '@/generated/tenant';
import type {
  CustomerDocument,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  createDocumentInputSchema,
  updateDocumentInputSchema,
  type CreateDocumentInput,
  type UpdateDocumentInput,
} from '@/lib/validation/customers';

// =============================================================================
// Customer documents — encrypted-at-rest scalars + file-attachment metadata.
//
// SECURITY-CRITICAL MODULE. Read every comment before editing.
//
// EIN / SSN / DRIVERS_LICENSE values are stored as ciphertext (AES-256-GCM
// via lib/crypto). Cleartext NEVER lands in:
//   - the database (only ciphertext + iv)
//   - the audit log (redacted via redactForAudit before any audit() call)
//   - the customer activity log (only `kind` + filename are recorded)
//   - any console / logger output anywhere in this file
//
// The single audited path that returns cleartext is readEncryptedValue().
// It writes a SENSITIVE_READ AuditLog row BEFORE attempting decryption so
// the access attempt is recorded regardless of whether decrypt succeeds —
// tampered ciphertext detection is itself a high-value security signal.
// =============================================================================

const SENSITIVE_KINDS = new Set<CustomerDocumentKind>([
  CustomerDocumentKind.EIN,
  CustomerDocumentKind.SSN,
  CustomerDocumentKind.DRIVERS_LICENSE,
]);

function isSensitiveKind(kind: CustomerDocumentKind): boolean {
  return SENSITIVE_KINDS.has(kind);
}

/**
 * Strip the encrypted scalar fields from a document record before it
 * goes into any AuditLog or CustomerActivity payload. Replaces them
 * with a boolean presence flag so the audit row remains useful for
 * "did we have a cleartext stored?" questions without ever leaking
 * ciphertext or IV (the IV alone is not secret, but combined with
 * other accidental leaks it shrinks the attacker's search space).
 */
function redactForAudit(row: CustomerDocument): Record<string, unknown> {
  const { encryptedValue, encryptedValueIv, ...rest } = row;
  return {
    ...rest,
    hasEncryptedValue: encryptedValue != null && encryptedValueIv != null,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createDocument(
  db: PrismaClient,
  customerId: string,
  input: CreateDocumentInput,
  ctx?: AuditContext,
): Promise<CustomerDocument> {
  const data = createDocumentInputSchema.parse(input);

  // Encrypt OUTSIDE the transaction so the cleartext lives in memory
  // for the shortest possible window and never crosses an `await`
  // boundary together with any database identifier we'd be tempted
  // to log. The cleartext local goes out of scope at function return.
  let encryptedValue: string | null = null;
  let encryptedValueIv: string | null = null;
  let storageKey: string | null = null;
  let fileName: string | null = null;
  let contentType: string | null = null;

  if (data.kind === 'EIN' || data.kind === 'SSN' || data.kind === 'DRIVERS_LICENSE') {
    const enc = encrypt(data.cleartextValue);
    encryptedValue = enc.ciphertext;
    encryptedValueIv = enc.iv;
  } else {
    storageKey = data.storageKey;
    fileName = data.fileName;
    contentType = data.contentType;
  }

  return db.$transaction(async (tx) => {
    const created = await tx.customerDocument.create({
      data: {
        customerId,
        kind: data.kind,
        encryptedValue,
        encryptedValueIv,
        storageKey,
        fileName,
        contentType,
        expiresOn: data.expiresOn ?? null,
        notes: data.notes ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerDocument',
      entityId: created.id,
      after: redactForAudit(created),
      ctx,
    });
    // Customer-facing activity entry. NEVER include cleartext or
    // storageKey contents. Filename is OK for files (the user
    // uploaded it knowing it'd be visible to staff).
    await tx.customerActivity.create({
      data: {
        customerId,
        kind: CustomerActivityKind.AUTO,
        summary: 'document_added',
        detailJson: {
          kind: created.kind,
          ...(created.fileName ? { fileName: created.fileName } : {}),
        },
        createdById: ctx?.userId ?? null,
      },
    });
    return created;
  });
}

/**
 * In-place update of a document record. Kind cannot change.
 *
 * - Sensitive kinds: supply `cleartextValue` to re-encrypt the stored value.
 *   The new ciphertext replaces the old; the old cleartext is never logged.
 * - File kinds: supply `storageKey/fileName/contentType` to swap the stored
 *   file reference (used by the replace-file endpoint after uploading to Spaces).
 * - Any kind: `expiresOn` and `notes` can be updated independently.
 *
 * SECURITY: same rules as createDocument — cleartext never appears in audit rows.
 */
export async function updateDocument(
  db: PrismaClient,
  id: string,
  input: UpdateDocumentInput,
  ctx?: AuditContext,
): Promise<CustomerDocument> {
  const data = updateDocumentInputSchema.parse(input);

  const before = await db.customerDocument.findFirst({
    where: { id, deletedAt: null },
  });
  if (!before) throw new Error(`CustomerDocument not found: ${id}`);

  // Enforce kind-compatibility of the supplied fields.
  if (data.cleartextValue !== undefined && !isSensitiveKind(before.kind)) {
    throw new Error(
      `cleartextValue is only valid for sensitive document kinds (EIN/SSN/DRIVERS_LICENSE), got ${before.kind}`,
    );
  }
  if (
    (data.storageKey !== undefined ||
      data.fileName !== undefined ||
      data.contentType !== undefined) &&
    isSensitiveKind(before.kind)
  ) {
    throw new Error(
      `storageKey/fileName/contentType cannot be set on sensitive document kind ${before.kind}`,
    );
  }

  // Encrypt outside the transaction for the same reasons as createDocument.
  let newEncryptedValue: string | undefined;
  let newEncryptedValueIv: string | undefined;
  if (data.cleartextValue !== undefined) {
    const enc = encrypt(data.cleartextValue);
    newEncryptedValue = enc.ciphertext;
    newEncryptedValueIv = enc.iv;
  }

  return db.$transaction(async (tx) => {
    const updateData: Prisma.CustomerDocumentUpdateInput = {};

    // Apply only the fields that were explicitly supplied.
    if ('expiresOn' in data) updateData.expiresOn = data.expiresOn ?? null;
    if ('notes' in data) updateData.notes = data.notes ?? null;
    if (newEncryptedValue !== undefined) {
      updateData.encryptedValue = newEncryptedValue;
      updateData.encryptedValueIv = newEncryptedValueIv!;
    }
    if (data.storageKey !== undefined) updateData.storageKey = data.storageKey;
    if (data.fileName !== undefined) updateData.fileName = data.fileName;
    if (data.contentType !== undefined) updateData.contentType = data.contentType;

    const after = await tx.customerDocument.update({
      where: { id },
      data: updateData,
    });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerDocument',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return after;
  });
}

export async function softDeleteDocument(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CustomerDocument> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerDocument.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerDocument not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerDocument is already soft-deleted');
    const after = await tx.customerDocument.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerDocument',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return after;
  });
}

/**
 * Metadata-only fetch. NEVER returns the encrypted columns; callers
 * that need cleartext go through readEncryptedValue() (audited path).
 */
export async function getDocumentMetadata(
  db: PrismaClient,
  id: string,
): Promise<Omit<CustomerDocument, 'encryptedValue' | 'encryptedValueIv'> | null> {
  const doc = await db.customerDocument.findFirst({
    where: { id, deletedAt: null },
  });
  if (!doc) return null;
  // Strip encrypted columns at the service boundary — the API layer
  // would also have to omit them, but defense in depth.
  const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
  void _ev;
  void _eviv;
  return rest;
}

export async function listDocumentsForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<Array<Omit<CustomerDocument, 'encryptedValue' | 'encryptedValueIv'>>> {
  const docs = await db.customerDocument.findMany({
    where: { customerId, deletedAt: null },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
  });
  return docs.map((d) => {
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = d;
    void _ev;
    void _eviv;
    return rest;
  });
}

/**
 * Documents whose `expiresOn` falls within the next N days. Used by
 * the "documents expiring in 30 days" dashboard widget per
 * docs/03-customers.md. Returns metadata only — never touches
 * encryptedValue. Excludes soft-deleted rows.
 *
 * Mirrors the documentsExpiringWithin helper on the customer service
 * but typed with explicit shape.
 */
export async function findDocumentsExpiringWithin(
  db: PrismaClient,
  days: number,
  now: Date = new Date(),
): Promise<
  Array<{
    id: string;
    customerId: string;
    customerName: string;
    kind: CustomerDocumentKind;
    fileName: string | null;
    expiresOn: Date;
  }>
> {
  if (days < 0) throw new Error('days must be >= 0');
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const docs = await db.customerDocument.findMany({
    where: {
      deletedAt: null,
      expiresOn: { gte: now, lte: cutoff },
    },
    include: { customer: { select: { name: true } } },
    orderBy: { expiresOn: 'asc' },
  });
  return docs.map((d) => ({
    id: d.id,
    customerId: d.customerId,
    customerName: d.customer.name,
    kind: d.kind,
    fileName: d.fileName,
    expiresOn: d.expiresOn!,
  }));
}

// ---------------------------------------------------------------------------
// Audited cleartext read
// ---------------------------------------------------------------------------

/**
 * Decrypt and return the cleartext value for a sensitive document
 * (EIN / SSN / DRIVERS_LICENSE).
 *
 * SECURITY CONTRACT — read carefully:
 *   - This is the ONLY supported path to retrieve cleartext for a
 *     sensitive customer document. Do not bypass it.
 *   - A SENSITIVE_READ AuditLog row is written BEFORE the decrypt
 *     attempt, so the access is recorded regardless of whether
 *     decryption succeeds. Tampered-ciphertext attempts are
 *     themselves a security signal worth capturing.
 *   - The audit row records only { documentId, kind, decryptError? }.
 *     It NEVER contains cleartext, NEVER a hash of cleartext,
 *     NEVER the ciphertext or IV.
 *   - For non-sensitive kinds (file attachments) the function throws
 *     without writing any audit row — there's no decryption to attempt.
 *
 * CALLER OBLIGATION: the returned cleartext string MUST be treated
 * ephemerally. Do NOT log it. Do NOT persist it. Do NOT pass it to
 * any audit() / activity() / console.* call. Do NOT return it in
 * structured data that could be cached. Only render it directly to
 * the consenting human user (via the /cleartext endpoint, which sets
 * Cache-Control: no-store).
 */
export async function readEncryptedValue(
  db: PrismaClient,
  documentId: string,
  ctx?: AuditContext,
): Promise<string> {
  const doc = await db.customerDocument.findFirst({
    where: { id: documentId, deletedAt: null },
  });
  if (!doc) throw new Error(`CustomerDocument not found: ${documentId}`);
  if (!isSensitiveKind(doc.kind)) {
    throw new Error(
      `Document kind ${doc.kind} has no encrypted value — readEncryptedValue is only for EIN / SSN / DRIVERS_LICENSE`,
    );
  }
  if (!doc.encryptedValue || !doc.encryptedValueIv) {
    // Audit the access attempt before throwing — we want visibility
    // into "someone tried to read a sensitive doc that has no
    // ciphertext stored", which is itself anomalous.
    await audit(db, {
      action: AuditAction.SENSITIVE_READ,
      entityType: 'CustomerDocument',
      entityId: documentId,
      before: {
        documentId,
        kind: doc.kind,
        decryptError: 'document missing encrypted value',
      },
      ctx,
    });
    throw new Error(`CustomerDocument ${documentId} has no encrypted value stored`);
  }

  // Audit FIRST — committed independently of the decrypt attempt that
  // follows. If decrypt throws (tamper), the audit row stays.
  // Same outside-the-tx pattern as INSUFFICIENT_STOCK_AT_CLOSE.
  await audit(db, {
    action: AuditAction.SENSITIVE_READ,
    entityType: 'CustomerDocument',
    entityId: documentId,
    before: {
      documentId,
      kind: doc.kind,
    },
    ctx,
  });

  // decrypt() throws on auth-tag failure (tampered ciphertext, wrong
  // key, mismatched IV). The thrown error propagates to the caller
  // unchanged — we explicitly do NOT log the error message because it
  // could in principle reveal information about the cipher state.
  return decrypt(doc.encryptedValue, doc.encryptedValueIv);
}
