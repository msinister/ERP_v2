import { z } from 'zod';

// =============================================================================
// Per-user UI preference shapes. The UserPreference store is generic
// (key → JSON); these schemas validate the value per known key so junk
// can't land in the table and so the PUT endpoint stays reusable across
// list pages. Add a list page by registering its key here.
// =============================================================================

// A list-page table view: sparse column-visibility overrides (columnId →
// bool; absent column falls back to the page's default), a display order
// (column ids; unknown/missing ids are reconciled against the page's column
// set at read time), + image default.
export const tableViewPrefSchema = z.object({
  columns: z.record(z.string(), z.boolean()).optional(),
  order: z.array(z.string()).optional(),
  showImages: z.boolean().optional(),
});
export type TableViewPref = z.infer<typeof tableViewPrefSchema>;

// Registry of known preference keys → value schema.
export const PREFERENCE_SCHEMAS = {
  'table.products': tableViewPrefSchema,
  'table.salesOrders': tableViewPrefSchema,
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;

export function isPreferenceKey(k: string): k is PreferenceKey {
  return Object.prototype.hasOwnProperty.call(PREFERENCE_SCHEMAS, k);
}
