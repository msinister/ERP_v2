import { AuditAction, Prisma } from '@/generated/tenant';
import type {
  PrismaClient,
  VendorPaymentMethod,
  VendorPaymentMethodKind,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  achPayloadSchema,
  checkPayloadSchema,
  createVendorPaymentMethodInputSchema,
  creditCardPayloadSchema,
  updateVendorPaymentMethodInputSchema,
  wirePayloadSchema,
  type CreateVendorPaymentMethodInput,
  type DecryptedVendorPaymentMethod,
  type UpdateVendorPaymentMethodInput,
} from '@/lib/validation/vendors';

// =============================================================================
// Vendor payment methods — encrypted at rest.
//
// SECURITY-CRITICAL MODULE. Read every comment before editing.
//
// The cleartext payload (account/routing numbers, payee details, card
// metadata) is AES-256-GCM ciphertext in encryptedPayload + IV in
// encryptedPayloadIv (lib/crypto). Cleartext NEVER lands in:
//   - the database (only ciphertext + iv)
//   - the audit log (redacted via redactForAudit before any audit() call)
//   - any console / logger output anywhere in this file
//
// The single audited path that returns cleartext is readDecryptedPayload().
// It writes a SENSITIVE_READ AuditLog row BEFORE attempting decryption so
// the access attempt is recorded regardless of whether decrypt succeeds —
// tampered ciphertext detection is itself a high-value security signal.
//
// Payload is IMMUTABLE per design. Update covers only label / isPreferred
// / active. To rotate an account number, soft-delete the row and create
// a new one — keeps this service simple and matches the "encrypted blobs
// are write-once" idiom.
// =============================================================================

// Metadata-only shape — the encrypted columns are stripped at the
// service boundary. Callers that need cleartext go through
// readDecryptedPayload (audited path).
export type VendorPaymentMethodMetadata = Omit<
  VendorPaymentMethod,
  'encryptedPayload' | 'encryptedPayloadIv'
>;

function stripEncrypted(row: VendorPaymentMethod): VendorPaymentMethodMetadata {
  const { encryptedPayload: _ep, encryptedPayloadIv: _epiv, ...rest } = row;
  void _ep;
  void _epiv;
  return rest;
}

/**
 * Strip the encrypted columns from a payment-method record before it
 * goes into any AuditLog payload. Replaces them with a boolean presence
 * flag so the audit row remains useful for "did we have ciphertext
 * stored?" questions without ever leaking ciphertext or IV (the IV
 * alone is not secret, but combined with other accidental leaks it
 * shrinks the attacker's search space).
 */
function redactForAudit(row: VendorPaymentMethod): Record<string, unknown> {
  const { encryptedPayload, encryptedPayloadIv, ...rest } = row;
  return {
    ...rest,
    hasEncryptedPayload: encryptedPayload != null && encryptedPayloadIv != null,
  };
}

// ---------------------------------------------------------------------------
// Display hint derivation (server-side, non-sensitive summary only)
// ---------------------------------------------------------------------------
//
// Stored in the clear so list/detail UIs don't have to decrypt to render
// a row. Must NEVER include account numbers in full, full SWIFT codes,
// or any other reversible payload data — only short suffixes / payee
// names / brand strings the user themselves treats as identifiers.

function tail4(s: string): string {
  return s.length > 4 ? `****${s.slice(-4)}` : '****';
}

function deriveDisplayHint(
  input: CreateVendorPaymentMethodInput,
): string {
  switch (input.kind) {
    case 'ACH':
      return `ACH ${tail4(input.payload.accountNumber)}`;
    case 'WIRE':
      return `Wire ${tail4(input.payload.accountNumber)}`;
    case 'CHECK':
      return `Check to: ${input.payload.payeeName}`;
    case 'CREDIT_CARD':
      return `${input.payload.brand} ****${input.payload.last4}`;
  }
}

// ---------------------------------------------------------------------------
// Lock + invariant helpers
// ---------------------------------------------------------------------------

async function lockVendor(
  tx: Prisma.TransactionClient,
  vendorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Vendor" WHERE "id" = ${vendorId} FOR UPDATE`;
}

async function clearOtherPreferred(
  tx: Prisma.TransactionClient,
  vendorId: string,
  exceptId: string | null,
): Promise<void> {
  await tx.vendorPaymentMethod.updateMany({
    where: {
      vendorId,
      isPreferred: true,
      deletedAt: null,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    data: { isPreferred: false },
  });
}

// ---------------------------------------------------------------------------
// CRUD + lifecycle
// ---------------------------------------------------------------------------

export async function createVendorPaymentMethod(
  db: PrismaClient,
  vendorId: string,
  input: CreateVendorPaymentMethodInput,
  ctx?: AuditContext,
): Promise<VendorPaymentMethodMetadata> {
  const data = createVendorPaymentMethodInputSchema.parse(input);
  const displayHint = deriveDisplayHint(data);

  // Encrypt OUTSIDE the transaction so the cleartext lives in memory
  // for the shortest possible window and never crosses an `await`
  // boundary together with any database identifier we'd be tempted to
  // log. The cleartext locals go out of scope at function return.
  // Same pattern as customerDocuments.createDocument.
  const plaintext = JSON.stringify(data.payload);
  const enc = encrypt(plaintext);

  return db.$transaction(async (tx) => {
    await lockVendor(tx, vendorId);
    if (data.isPreferred) {
      await clearOtherPreferred(tx, vendorId, null);
    }
    const created = await tx.vendorPaymentMethod.create({
      data: {
        vendorId,
        kind: data.kind,
        label: data.label ?? null,
        encryptedPayload: enc.ciphertext,
        encryptedPayloadIv: enc.iv,
        displayHint,
        isPreferred: data.isPreferred ?? false,
        active: data.active ?? true,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'VendorPaymentMethod',
      entityId: created.id,
      after: redactForAudit(created),
      ctx,
    });
    return stripEncrypted(created);
  });
}

export async function updateVendorPaymentMethod(
  db: PrismaClient,
  id: string,
  input: UpdateVendorPaymentMethodInput,
  ctx?: AuditContext,
): Promise<VendorPaymentMethodMetadata> {
  const data = updateVendorPaymentMethodInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.vendorPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`VendorPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('VendorPaymentMethod is soft-deleted');

    await lockVendor(tx, before.vendorId);

    const becomingPreferred = data.isPreferred === true && before.isPreferred === false;
    if (becomingPreferred) {
      await clearOtherPreferred(tx, before.vendorId, before.id);
    }

    const updateData: Prisma.VendorPaymentMethodUpdateInput = {};
    if ('label' in data) updateData.label = data.label ?? null;
    if (data.isPreferred !== undefined) updateData.isPreferred = data.isPreferred;
    if (data.active !== undefined) updateData.active = data.active;

    const after = await tx.vendorPaymentMethod.update({ where: { id }, data: updateData });

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return stripEncrypted(after);
  });
}

/**
 * Soft-delete a payment method. If the row had isPreferred=true, the
 * flag is cleared in the SAME transaction — same rationale as
 * softDeleteAddress / softDeleteContact: avoids a "ghost preferred"
 * deleted row, and frees the singleton slot so a new preferred can be
 * set immediately.
 */
export async function softDeleteVendorPaymentMethod(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<VendorPaymentMethodMetadata> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`VendorPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('VendorPaymentMethod is already soft-deleted');

    await lockVendor(tx, before.vendorId);

    const after = await tx.vendorPaymentMethod.update({
      where: { id },
      data: { deletedAt: new Date(), isPreferred: false },
    });

    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'VendorPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx,
    });
    return stripEncrypted(after);
  });
}

export async function setPreferredVendorPaymentMethod(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<VendorPaymentMethodMetadata> {
  return db.$transaction(async (tx) => {
    const before = await tx.vendorPaymentMethod.findUnique({ where: { id } });
    if (!before) throw new Error(`VendorPaymentMethod not found: ${id}`);
    if (before.deletedAt) throw new Error('VendorPaymentMethod is soft-deleted');

    await lockVendor(tx, before.vendorId);
    await clearOtherPreferred(tx, before.vendorId, before.id);

    const after = await tx.vendorPaymentMethod.update({
      where: { id },
      data: { isPreferred: true },
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'VendorPaymentMethod',
      entityId: id,
      before: redactForAudit(before),
      after: redactForAudit(after),
      ctx: { ...ctx, reason: 'set as preferred vendor payment method' },
    });
    return stripEncrypted(after);
  });
}

// ---------------------------------------------------------------------------
// Reads — metadata only
// ---------------------------------------------------------------------------

export async function getVendorPaymentMethodMetadata(
  db: PrismaClient,
  id: string,
): Promise<VendorPaymentMethodMetadata | null> {
  const row = await db.vendorPaymentMethod.findFirst({
    where: { id, deletedAt: null },
  });
  return row ? stripEncrypted(row) : null;
}

export async function listVendorPaymentMethods(
  db: PrismaClient,
  vendorId: string,
): Promise<VendorPaymentMethodMetadata[]> {
  const rows = await db.vendorPaymentMethod.findMany({
    where: { vendorId, deletedAt: null },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map(stripEncrypted);
}

// ---------------------------------------------------------------------------
// Audited cleartext read
// ---------------------------------------------------------------------------

/**
 * Decrypt and return the cleartext payload for a vendor payment method.
 *
 * SECURITY CONTRACT — read carefully:
 *   - This is the ONLY supported path to retrieve cleartext for a
 *     VendorPaymentMethod row. Do not bypass it.
 *   - A SENSITIVE_READ AuditLog row is written BEFORE the decrypt
 *     attempt, so the access is recorded regardless of whether
 *     decryption succeeds. Tampered-ciphertext attempts are themselves
 *     a security signal worth capturing.
 *   - The audit row records only { vendorPaymentMethodId, kind }.
 *     It NEVER contains cleartext, NEVER a hash of cleartext,
 *     NEVER the ciphertext or IV.
 *
 * CALLER OBLIGATION: the returned cleartext payload MUST be treated
 * ephemerally. Do NOT log it. Do NOT persist it. Do NOT pass it to
 * any audit() / activity() / console.* call. Do NOT return it in
 * structured data that could be cached. Only render it directly to
 * the consenting human user (via a Cache-Control: no-store endpoint).
 */
export async function readDecryptedVendorPaymentMethodPayload(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<DecryptedVendorPaymentMethod> {
  const row = await db.vendorPaymentMethod.findFirst({
    where: { id, deletedAt: null },
  });
  if (!row) throw new Error(`VendorPaymentMethod not found: ${id}`);

  // Audit FIRST — committed independently of the decrypt attempt that
  // follows. If decrypt throws (tamper), the audit row stays.
  // Same outside-the-tx pattern as customerDocuments.readEncryptedValue.
  await audit(db, {
    action: AuditAction.SENSITIVE_READ,
    entityType: 'VendorPaymentMethod',
    entityId: id,
    before: {
      vendorPaymentMethodId: id,
      kind: row.kind,
    },
    ctx,
  });

  // decrypt() throws on auth-tag failure (tampered ciphertext, wrong
  // key, mismatched IV). The thrown error propagates to the caller
  // unchanged — we explicitly do NOT log the error message because it
  // could in principle reveal information about the cipher state.
  const cleartext = decrypt(row.encryptedPayload, row.encryptedPayloadIv);
  const parsed = JSON.parse(cleartext) as unknown;

  // Re-validate the decrypted payload against its kind-specific schema.
  // Defense in depth: if the schema ever tightens, stale ciphertexts
  // that no longer satisfy it surface as a Zod error rather than a
  // silent type assertion.
  return validateDecryptedPayload(row.kind, parsed);
}

function validateDecryptedPayload(
  kind: VendorPaymentMethodKind,
  parsed: unknown,
): DecryptedVendorPaymentMethod {
  switch (kind) {
    case 'ACH':
      return { kind: 'ACH', payload: achPayloadSchema.parse(parsed) };
    case 'WIRE':
      return { kind: 'WIRE', payload: wirePayloadSchema.parse(parsed) };
    case 'CHECK':
      return { kind: 'CHECK', payload: checkPayloadSchema.parse(parsed) };
    case 'CREDIT_CARD':
      return { kind: 'CREDIT_CARD', payload: creditCardPayloadSchema.parse(parsed) };
  }
}
