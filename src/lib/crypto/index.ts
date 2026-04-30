import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level AES-256-GCM encryption for at-rest storage of customer
 * sensitive identifiers (EIN, SSN, driver's license number).
 *
 * SCOPE — what this helper IS for:
 *   - Encrypting short scalar PII strings before persisting them to
 *     CustomerDocument.encryptedValue.
 *   - Decrypting the same on the audited read path.
 *
 * SCOPE — what this helper is NOT for:
 *   - Raw cardholder data (PAN, CVV, magnetic stripe, etc.). Card data
 *     never enters the ERP — Authorize.Net CIM token IDs only. Storing
 *     PAN here would put us in PCI scope. Don't.
 *   - The SENSITIVE_READ audit row. That's the responsibility of the
 *     calling service (customerDocuments) — this module only handles the
 *     cipher math. Keeping audit out of here lets the same primitive be
 *     reused in other contexts later without producing spurious audit
 *     rows when cleartext is needed for non-customer purposes.
 *
 * Algorithm:
 *   - AES-256-GCM via Node's built-in crypto (no new deps).
 *   - 256-bit key sourced from process.env.TENANT_FIELD_ENCRYPTION_KEY,
 *     base64-encoded; this module throws at load if the env var is
 *     missing or doesn't decode to exactly 32 bytes.
 *   - 96-bit (12-byte) random IV per encrypt call (NIST recommendation
 *     for GCM).
 *   - Output ciphertext is the concatenation of GCM_ciphertext_bytes
 *     followed by the 16-byte GCM auth tag, base64-encoded as a single
 *     string. The IV is returned separately as base64 (it is not secret
 *     but is required for decryption and stored alongside the
 *     ciphertext on CustomerDocument.encryptedValueIv).
 *   - decrypt() throws if the auth tag fails verification (tampered
 *     ciphertext or wrong IV), per GCM semantics.
 *
 * TODO: key rotation — see CLAUDE.md operational notes. Today this
 * helper assumes a single static key; production rotation will require
 * (a) a key id stored alongside ciphertext, (b) a key registry that
 * resolves id → key, and (c) a re-encrypt sweep on rotation events.
 * Not blocking for pilot.
 */

const ALGO = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = process.env.TENANT_FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TENANT_FIELD_ENCRYPTION_KEY is not set; cannot perform field-level encryption',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('TENANT_FIELD_ENCRYPTION_KEY must be base64-encoded');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TENANT_FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

// Eager validation: any caller that imports this module fails fast in
// environments where the key is missing. Tests wire the key via
// tests/helpers/setupGlobalEnv.ts before any module loads.
const KEY: Buffer = loadKey();

export type EncryptedField = {
  /** base64( ciphertext-bytes || 16-byte GCM auth tag ) */
  ciphertext: string;
  /** base64( 12-byte random IV ) */
  iv: string;
};

export function encrypt(plaintext: string): EncryptedField {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt(plaintext): plaintext must be a string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decrypt(ciphertext: string, iv: string): string {
  const ivBuf = Buffer.from(iv, 'base64');
  if (ivBuf.length !== IV_BYTES) {
    throw new Error(`decrypt(): iv must be ${IV_BYTES} bytes (got ${ivBuf.length})`);
  }
  const blob = Buffer.from(ciphertext, 'base64');
  // Empty plaintext is legal — its blob is exactly TAG_BYTES (16 bytes of
  // auth tag, zero payload). Reject only blobs that can't even fit a tag.
  if (blob.length < TAG_BYTES) {
    throw new Error('decrypt(): ciphertext too short to contain GCM auth tag');
  }
  const enc = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGO, KEY, ivBuf);
  decipher.setAuthTag(tag);
  // .final() throws if the auth tag fails verification — GCM semantics
  // make any tampered byte (ciphertext, IV, key) detectable.
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
