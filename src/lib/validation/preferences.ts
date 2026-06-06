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

// Dashboard widget layout: display order + soft-hidden set. The registry
// reconciles unknown IDs at read time, so saved orders survive widget renames.
export const dashboardWidgetsPrefSchema = z.object({
  order: z.array(z.string()).optional(),
  hidden: z.array(z.string()).optional(),
});
export type DashboardWidgetsPref = z.infer<typeof dashboardWidgetsPrefSchema>;

// Registry of known preference keys → value schema.
export const PREFERENCE_SCHEMAS = {
  'dashboard.widgets': dashboardWidgetsPrefSchema,
  'table.products': tableViewPrefSchema,
  'table.salesOrders': tableViewPrefSchema,
  'table.purchaseOrders': tableViewPrefSchema,
  'table.bills': tableViewPrefSchema,
  'table.creditMemos': tableViewPrefSchema,
  'table.rmas': tableViewPrefSchema,
  'table.vendorCredits': tableViewPrefSchema,
  'table.payments': tableViewPrefSchema,
  'table.workOrders': tableViewPrefSchema,
  'table.customers': tableViewPrefSchema,
  'table.vendors': tableViewPrefSchema,
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;

export function isPreferenceKey(k: string): k is PreferenceKey {
  return Object.prototype.hasOwnProperty.call(PREFERENCE_SCHEMAS, k);
}
