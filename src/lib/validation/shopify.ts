import { z } from 'zod';

// =============================================================================
// Shopify config — admin-managed settings persisted under Setting key
// 'shopify.config'. Secrets are stored encrypted (lib/crypto) before they
// reach the JSON column; the schema here is the cleartext shape the admin
// form posts and the test/sync routes consume.
// =============================================================================

// Bare-host form: "mystore.myshopify.com" (no protocol, no trailing slash,
// no path). The Shopify client tacks on https:// + /admin/api/... — keeping
// the stored value canonical avoids URL surprises if the field is ever
// echoed to logs.
const STORE_URL_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export const shopifyConfigInputSchema = z.object({
  storeUrl: z
    .string()
    .trim()
    .toLowerCase()
    .regex(STORE_URL_RE, 'Must look like "mystore.myshopify.com"'),
  // Token / secret are optional on PUT — empty/absent means "leave the
  // currently-stored value alone". This lets an admin save a syncEnabled
  // toggle without re-typing the secret.
  accessToken: z.string().trim().min(1).max(512).optional(),
  webhookSecret: z.string().trim().min(1).max(512).optional(),
  syncEnabled: z.boolean(),
});

export type ShopifyConfigInput = z.infer<typeof shopifyConfigInputSchema>;
