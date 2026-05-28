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

const customerTypeEnum = z.enum([
  'WHOLESALE_REGULAR',
  'WHOLESALE_PREFERRED',
  'WHOLESALE_DISTRIBUTOR',
  'WHOLESALE_MASTER_DISTRIBUTOR',
  'RETAIL',
]);

// =============================================================================
// Address sub-schemas
// =============================================================================
//
// Two variants share most fields. Discriminated by `kind`. The billing
// variant is forced to kind=BILLING (one billing address per customer
// is the spec). Shipping addresses carry `isDefault` so a single
// default ship-to can be flagged among many.

const addressBaseShape = {
  label: z.string().max(255).optional(),
  line1: z.string().min(1).max(500),
  line2: z.string().max(500).optional(),
  city: z.string().min(1).max(255),
  region: z.string().min(1).max(255), // state/province
  postalCode: z.string().min(1).max(32),
  country: z.string().length(2).optional(), // ISO-3166 alpha-2; defaults to "US" at the DB
  attention: z.string().max(255).optional(),
  phone: z.string().max(64).optional(),
};

export const billingAddressInputSchema = z.object({
  ...addressBaseShape,
  kind: z.literal('BILLING'),
});

export const shippingAddressInputSchema = z.object({
  ...addressBaseShape,
  kind: z.literal('SHIPPING'),
  isDefault: z.boolean().optional(),
});

export const addressInputSchema = z.discriminatedUnion('kind', [
  billingAddressInputSchema,
  shippingAddressInputSchema,
]);

export const updateAddressInputSchema = z.object({
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

export const createContactInputSchema = z.object({
  name: z.string().min(1).max(255),
  // Free-form per spec; common values: Owner, Buyer, AP, AR, Manager, Shipping.
  role: z.string().max(64).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(64).optional(),
  mobile: z.string().max(64).optional(),
  isPrimary: z.boolean().optional(),
});

export const updateContactInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: z.string().max(64).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  mobile: z.string().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

// =============================================================================
// Customer master — create / update
// =============================================================================

export const createCustomerInputSchema = z.object({
  // `code` is auto-issued by the service via the Sequence helper
  // (CUST-YYYY-NNNNN). Kept optional in the input so callers can
  // override for migration imports; service falls back to the sequence.
  code: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(255),
  type: customerTypeEnum.optional(),
  // Required relations.
  salesRepId: z.string().min(1),
  paymentTermId: z.string().min(1),
  // Financial terms.
  creditLimit: nonNegativeDecimal.optional(),
  arHoldDays: z.number().int().min(0).max(3650).optional(),
  taxExempt: z.boolean().optional(),
  resaleCertNumber: z.string().max(128).optional(),
  // Contact summary.
  primaryPhone: z.string().max(64).optional(),
  primaryEmail: z.string().email().max(255).optional(),
  internalNotes: z.string().max(10000).optional(),
  costPlusPercent: percentDecimal.optional(),
  active: z.boolean().optional(),
  createdById: z.string().optional(),
  // Composite payload. Address is optional so the operator can stand
  // up a vendor relationship without a billing address on hand (cash
  // sales, walk-in customers, drop-ship-only relationships); they can
  // add one later from the customer detail page.
  billingAddress: billingAddressInputSchema.optional(),
  defaultShippingAddress: shippingAddressInputSchema.optional(),
  additionalShippingAddresses: z.array(shippingAddressInputSchema).optional(),
  contacts: z.array(createContactInputSchema).optional(),
  tagLabels: z.array(z.string().min(1).max(64)).optional(),
  categoryIds: z.array(z.string().min(1)).optional(),
});

export const updateCustomerInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: customerTypeEnum.optional(),
  salesRepId: z.string().min(1).optional(),
  paymentTermId: z.string().min(1).optional(),
  creditLimit: nonNegativeDecimal.nullable().optional(),
  arHoldDays: z.number().int().min(0).max(3650).nullable().optional(),
  taxExempt: z.boolean().optional(),
  resaleCertNumber: z.string().max(128).nullable().optional(),
  primaryPhone: z.string().max(64).nullable().optional(),
  primaryEmail: z.string().email().max(255).nullable().optional(),
  internalNotes: z.string().max(10000).nullable().optional(),
  costPlusPercent: percentDecimal.nullable().optional(),
  active: z.boolean().optional(),
});

// =============================================================================
// Customer-specific price overrides
// =============================================================================

export const createPriceOverrideInputSchema = z.object({
  variantId: z.string().min(1),
  unitPrice: positiveDecimal,
  // Multi-currency on price overrides — nullable, defaults to USD.
  currency: z.string().min(3).max(3).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

// One row of the bulk CSV import. Looked up by SKU server-side and
// converted to a (customerId, variantId) upsert. Per refinement #5:
// UPSERT-ONLY — rows omitted from the CSV are NEVER deleted.
export const bulkPriceOverrideCsvRowSchema = z.object({
  sku: z.string().min(1).max(255),
  unitPrice: positiveDecimal,
  currency: z.string().min(3).max(3).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

// =============================================================================
// Stored payment methods (Authorize.Net CIM tokens only)
// =============================================================================
//
// Defense-in-depth: any field carrying what looks like a raw card
// number gets rejected outright. The API surface should never see PAN
// — all card-handling stays in CIM via Accept.js / hosted forms — but
// this catches accidental misuse before anything reaches the DB.

const PAN_REGEX = /^[0-9]{12,19}$/;
const PAN_REJECT_MESSAGE =
  'Raw card data detected — only Authorize.Net CIM tokens are accepted';

function rejectAnyPan<T extends Record<string, unknown>>(data: T, ctx: z.RefinementCtx): void {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && PAN_REGEX.test(value.replace(/\s|-/g, ''))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: PAN_REJECT_MESSAGE,
      });
    }
  }
}

export const createPaymentMethodInputSchema = z
  .object({
    // CIM identifiers, opaque tokens — not card numbers.
    authorizeNetCustomerProfileId: z.string().min(1).max(128),
    authorizeNetPaymentProfileId: z.string().min(1).max(128),
    brand: z.string().max(32).optional(),
    last4: z
      .string()
      .regex(/^[0-9]{4}$/, 'Must be exactly 4 digits')
      .optional(),
    expirationMonth: z.number().int().min(1).max(12).optional(),
    expirationYear: z.number().int().min(2020).max(2100).optional(),
    isPreferred: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .superRefine(rejectAnyPan);

export const updatePaymentMethodInputSchema = z
  .object({
    brand: z.string().max(32).nullable().optional(),
    last4: z
      .string()
      .regex(/^[0-9]{4}$/, 'Must be exactly 4 digits')
      .nullable()
      .optional(),
    expirationMonth: z.number().int().min(1).max(12).nullable().optional(),
    expirationYear: z.number().int().min(2020).max(2100).nullable().optional(),
    isPreferred: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .superRefine(rejectAnyPan);

// =============================================================================
// Documents (encrypted scalars vs file attachments)
// =============================================================================
//
// Discriminated union by `kind`. EIN / SSN / DRIVERS_LICENSE require a
// cleartext scalar value (encrypted at-rest by the customerDocuments
// service via lib/crypto). The other kinds are file attachments and
// require a Spaces storage key + filename + content type.

const sensitiveDocKindEnum = z.enum(['EIN', 'SSN', 'DRIVERS_LICENSE']);
const fileDocKindEnum = z.enum([
  'RESALE_PERMIT',
  'BUSINESS_LICENSE',
  'RESALE_CERT',
  'OTHER',
]);

const sensitiveDocInput = z.object({
  kind: sensitiveDocKindEnum,
  cleartextValue: z.string().min(1).max(512),
  expiresOn: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});

const fileDocInput = z.object({
  kind: fileDocKindEnum,
  storageKey: z.string().min(1).max(512),
  fileName: z.string().min(1).max(512),
  contentType: z.string().min(1).max(255),
  expiresOn: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});

export const createDocumentInputSchema = z.discriminatedUnion('kind', [
  // Each branch of the discriminator is a separate object literal so
  // the discriminator stays a single literal type per branch.
  sensitiveDocInput.extend({ kind: z.literal('EIN') }),
  sensitiveDocInput.extend({ kind: z.literal('SSN') }),
  sensitiveDocInput.extend({ kind: z.literal('DRIVERS_LICENSE') }),
  fileDocInput.extend({ kind: z.literal('RESALE_PERMIT') }),
  fileDocInput.extend({ kind: z.literal('BUSINESS_LICENSE') }),
  fileDocInput.extend({ kind: z.literal('RESALE_CERT') }),
  fileDocInput.extend({ kind: z.literal('OTHER') }),
]);

// =============================================================================
// Activity log (manual entries — AUTO entries are written by services)
// =============================================================================

export const createActivityInputSchema = z.object({
  summary: z.string().min(1).max(2000),
  // MANUAL entries leave detailJson null per the schema comment in the
  // CustomerActivity model. AUTO entries are written by services with
  // the structured { field, from, to } shape.
});

// =============================================================================
// Lookup tables — categories and tags
// =============================================================================

export const createCategoryInputSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(255),
  active: z.boolean().optional(),
});

export const updateCategoryInputSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export const createTagInputSchema = z.object({
  label: z.string().min(1).max(64),
});

// =============================================================================
// Inferred types
// =============================================================================

export type BillingAddressInput = z.infer<typeof billingAddressInputSchema>;
export type ShippingAddressInput = z.infer<typeof shippingAddressInputSchema>;
export type AddressInput = z.infer<typeof addressInputSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressInputSchema>;

export type CreateContactInput = z.infer<typeof createContactInputSchema>;
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

export type CreateCustomerInput = z.infer<typeof createCustomerInputSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;

export type CreatePriceOverrideInput = z.infer<typeof createPriceOverrideInputSchema>;
export type BulkPriceOverrideCsvRow = z.infer<typeof bulkPriceOverrideCsvRowSchema>;

export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodInputSchema>;
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodInputSchema>;

export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

export type CreateActivityInput = z.infer<typeof createActivityInputSchema>;

export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>;
export type CreateTagInput = z.infer<typeof createTagInputSchema>;

// =============================================================================
// Transition-phase compatibility shim
// =============================================================================
//
// The stub createCustomer service (src/server/services/customers.ts)
// still uses the slim {code, name, active?} payload; it gets fully
// replaced in the upcoming customer-master service slice. Keeping this
// schema here (rather than in sales.ts where it used to live) so the
// stub doesn't reach into the SO module's validation file.
export const createCustomerStubInputSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  active: z.boolean().optional(),
});

export const updateCustomerStubInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export type CreateCustomerStubInput = z.infer<typeof createCustomerStubInputSchema>;
export type UpdateCustomerStubInput = z.infer<typeof updateCustomerStubInputSchema>;
