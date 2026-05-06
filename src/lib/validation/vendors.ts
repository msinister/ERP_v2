import { z } from 'zod';
import { decimalString } from './common';

// =============================================================================
// Shared primitives
// =============================================================================

const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be >= 0',
);
const positiveDecimal = decimalString.refine(
  (v) => Number(v) > 0,
  'Must be greater than 0',
);
const percentDecimal = decimalString.refine(
  (v) => {
    const n = Number(v);
    return n >= 0 && n <= 100;
  },
  'Must be between 0 and 100',
);

const vendorTypeEnum = z.enum(['STOCK', 'DROP_SHIP', 'SERVICE']);
const vendorAddressKindEnum = z.enum(['REMIT_TO', 'SHIPPING', 'BILLING']);

// =============================================================================
// Address sub-schemas
// =============================================================================
//
// Vendor addresses are kind-discriminated like CustomerAddress. REMIT_TO
// is the canonical AP destination (where checks get cut). Shipping is
// rare (e.g., pickup origin), Billing is rare (mailing). All three carry
// `isDefault` so a single default per kind can be flagged among many.

const vendorAddressBaseShape = {
  label: z.string().max(255).optional(),
  line1: z.string().min(1).max(500),
  line2: z.string().max(500).optional(),
  city: z.string().min(1).max(255),
  region: z.string().min(1).max(255),
  postalCode: z.string().min(1).max(32),
  country: z.string().length(2).optional(),
  attention: z.string().max(255).optional(),
  phone: z.string().max(64).optional(),
  isDefault: z.boolean().optional(),
};

export const remitToAddressInputSchema = z.object({
  ...vendorAddressBaseShape,
  kind: z.literal('REMIT_TO'),
});

export const vendorShippingAddressInputSchema = z.object({
  ...vendorAddressBaseShape,
  kind: z.literal('SHIPPING'),
});

export const vendorBillingAddressInputSchema = z.object({
  ...vendorAddressBaseShape,
  kind: z.literal('BILLING'),
});

export const vendorAddressInputSchema = z.discriminatedUnion('kind', [
  remitToAddressInputSchema,
  vendorShippingAddressInputSchema,
  vendorBillingAddressInputSchema,
]);

export const updateVendorAddressInputSchema = z.object({
  label: z.string().max(255).nullable().optional(),
  line1: z.string().min(1).max(500).optional(),
  line2: z.string().max(500).nullable().optional(),
  city: z.string().min(1).max(255).optional(),
  region: z.string().min(1).max(255).optional(),
  postalCode: z.string().min(1).max(32).optional(),
  country: z.string().length(2).optional(),
  attention: z.string().max(255).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  isDefault: z.boolean().optional(),
});

// =============================================================================
// Contact sub-schemas
// =============================================================================

export const createVendorContactInputSchema = z.object({
  name: z.string().min(1).max(255),
  // Free-form per spec; common values: Sales rep, AR, AP, Buyer, Owner.
  role: z.string().max(64).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(64).optional(),
  mobile: z.string().max(64).optional(),
  isPrimary: z.boolean().optional(),
});

export const updateVendorContactInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z.string().max(64).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  mobile: z.string().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

// =============================================================================
// Vendor master — create / update
// =============================================================================
//
// `paymentTermId` is REQUIRED at the service layer per Q2 — the model
// allows null only so legacy upsert-stub fixtures (11+ test files) keep
// passing. New vendors created via this schema must always supply it.
//
// `defaultCommissionRate` is schema room for the deferred drop-ship
// slice; accepted here so a future drop-ship type can be created
// end-to-end, but not enforced beyond range validation.

export const createVendorInputSchema = z.object({
  // Auto-issued by the service via the Sequence helper (VEND-YYYY-NNNNN)
  // when omitted; manual override allowed for migration imports.
  code: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(255),
  type: vendorTypeEnum.optional(),
  paymentTermId: z.string().min(1),
  defaultCurrency: z.string().min(3).max(3).optional(),
  minimumOrderAmount: nonNegativeDecimal.optional(),
  costChangeAlertPct: percentDecimal.optional(),
  defaultCommissionRate: percentDecimal.optional(),
  notes: z.string().max(10000).optional(),
  active: z.boolean().optional(),
  // Composite payload — optional, all written in one tx.
  remitToAddress: remitToAddressInputSchema.optional(),
  contacts: z.array(createVendorContactInputSchema).optional(),
});

export const updateVendorInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: vendorTypeEnum.optional(),
  paymentTermId: z.string().min(1).optional(),
  defaultCurrency: z.string().min(3).max(3).nullable().optional(),
  minimumOrderAmount: nonNegativeDecimal.nullable().optional(),
  costChangeAlertPct: percentDecimal.nullable().optional(),
  defaultCommissionRate: percentDecimal.nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  active: z.boolean().optional(),
});

// =============================================================================
// Vendor product catalog
// =============================================================================
//
// Per-vendor per-variant row. SERVICE-type vendors are blocked from
// creating catalog rows in the service layer (spec line 7: "service
// vendors are AP only, no products"). MOQ + lead time are deferred per
// spec lines 30-31 — schema has no columns and these schemas have no
// fields for them.

export const createVendorProductInputSchema = z.object({
  variantId: z.string().min(1),
  vendorSku: z.string().max(255).optional(),
  latestCost: positiveDecimal.optional(),
  packSize: positiveDecimal.optional(),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

export const updateVendorProductInputSchema = z.object({
  vendorSku: z.string().max(255).nullable().optional(),
  latestCost: positiveDecimal.nullable().optional(),
  packSize: positiveDecimal.nullable().optional(),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// =============================================================================
// Vendor payment methods (encrypted at rest)
// =============================================================================
//
// Per docs/04 line 15, each vendor can have multiple payment-method
// records on file. The cleartext payload is shape-discriminated by
// `kind` and persisted as a single AES-256-GCM ciphertext blob; these
// schemas validate the cleartext both BEFORE encryption (on create)
// and AFTER decryption (on the audited cleartext read path).
//
// CREDIT_CARD here is REFERENCE METADATA ONLY — last4 + brand + exp
// month/year. Full PAN never enters this table; full PAN goes through
// Authorize.Net CIM token IDs (see CustomerPaymentMethod). The `last4`
// regex below explicitly rejects 16-digit input as a defense-in-depth
// guard against a caller accidentally passing a full PAN.

const accountNumberRegex = /^[A-Za-z0-9-]{4,34}$/;
const routingNumberRegex = /^\d{9}$/; // US ABA routing
const swiftCodeRegex = /^[A-Z0-9]{8,11}$/;

export const achPayloadSchema = z.object({
  routingNumber: z.string().regex(routingNumberRegex, 'Must be a 9-digit ABA routing number'),
  accountNumber: z.string().regex(accountNumberRegex, 'Invalid account number'),
  accountName: z.string().min(1).max(255),
  bankName: z.string().max(255).optional(),
});

export const wirePayloadSchema = z.object({
  routingNumber: z.string().regex(routingNumberRegex, 'Must be a 9-digit ABA routing number'),
  accountNumber: z.string().regex(accountNumberRegex, 'Invalid account number'),
  accountName: z.string().min(1).max(255),
  bankName: z.string().max(255).optional(),
  swiftCode: z.string().regex(swiftCodeRegex, 'Invalid SWIFT/BIC').optional(),
  intermediaryBank: z.string().max(255).optional(),
});

export const checkPayloadSchema = z.object({
  payeeName: z.string().min(1).max(255),
  line1: z.string().min(1).max(500),
  line2: z.string().max(500).optional(),
  city: z.string().min(1).max(255),
  region: z.string().min(1).max(255),
  postalCode: z.string().min(1).max(32),
  country: z.string().length(2).optional(),
});

// last4 is exactly 4 digits — reject anything longer to keep a stray
// full PAN from being silently accepted as a "really long last4".
export const creditCardPayloadSchema = z.object({
  last4: z.string().regex(/^\d{4}$/, 'last4 must be exactly 4 digits — never store a full PAN'),
  brand: z.string().min(1).max(64),
  expirationMonth: z.number().int().min(1).max(12).optional(),
  expirationYear: z.number().int().min(2000).max(2100).optional(),
});

const paymentMethodBaseShape = {
  label: z.string().max(255).optional(),
  isPreferred: z.boolean().optional(),
  active: z.boolean().optional(),
};

export const createAchPaymentMethodSchema = z.object({
  ...paymentMethodBaseShape,
  kind: z.literal('ACH'),
  payload: achPayloadSchema,
});

export const createWirePaymentMethodSchema = z.object({
  ...paymentMethodBaseShape,
  kind: z.literal('WIRE'),
  payload: wirePayloadSchema,
});

export const createCheckPaymentMethodSchema = z.object({
  ...paymentMethodBaseShape,
  kind: z.literal('CHECK'),
  payload: checkPayloadSchema,
});

export const createCreditCardPaymentMethodSchema = z.object({
  ...paymentMethodBaseShape,
  kind: z.literal('CREDIT_CARD'),
  payload: creditCardPayloadSchema,
});

export const createVendorPaymentMethodInputSchema = z.discriminatedUnion('kind', [
  createAchPaymentMethodSchema,
  createWirePaymentMethodSchema,
  createCheckPaymentMethodSchema,
  createCreditCardPaymentMethodSchema,
]);

// Update covers ONLY non-payload fields. Payload is immutable per design;
// to change account/routing/etc., soft-delete the row and create a new one.
export const updateVendorPaymentMethodInputSchema = z.object({
  label: z.string().max(255).nullable().optional(),
  isPreferred: z.boolean().optional(),
  active: z.boolean().optional(),
});

// Discriminated union returned by readDecryptedPayload — the caller
// gets a typed { kind, payload } pair so the per-kind shape is recovered
// after decrypt + JSON.parse.
export type DecryptedVendorPaymentMethod =
  | { kind: 'ACH'; payload: z.infer<typeof achPayloadSchema> }
  | { kind: 'WIRE'; payload: z.infer<typeof wirePayloadSchema> }
  | { kind: 'CHECK'; payload: z.infer<typeof checkPayloadSchema> }
  | { kind: 'CREDIT_CARD'; payload: z.infer<typeof creditCardPayloadSchema> };

// =============================================================================
// Inferred types
// =============================================================================

export type RemitToAddressInput = z.infer<typeof remitToAddressInputSchema>;
export type VendorAddressInput = z.infer<typeof vendorAddressInputSchema>;
export type UpdateVendorAddressInput = z.infer<typeof updateVendorAddressInputSchema>;

export type CreateVendorContactInput = z.infer<typeof createVendorContactInputSchema>;
export type UpdateVendorContactInput = z.infer<typeof updateVendorContactInputSchema>;

export type CreateVendorInput = z.infer<typeof createVendorInputSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorInputSchema>;

export type CreateVendorProductInput = z.infer<typeof createVendorProductInputSchema>;
export type UpdateVendorProductInput = z.infer<typeof updateVendorProductInputSchema>;

export type CreateVendorPaymentMethodInput = z.infer<
  typeof createVendorPaymentMethodInputSchema
>;
export type UpdateVendorPaymentMethodInput = z.infer<
  typeof updateVendorPaymentMethodInputSchema
>;
