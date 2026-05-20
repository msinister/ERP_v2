// =============================================================================
// Permission catalog — the single source of truth for the granular
// permission keys custom Roles are built from.
//
// Super Admins bypass ALL of these (see lib/permissions/actor.ts
// hasPermission). Keys follow `<module>.<action>`.
//
// The grouped structure drives the role-editor checkbox UI. The derived
// `PermissionKey` union + `ALL_PERMISSION_KEYS` drive validation and type
// safety. Add a permission by editing PERMISSION_GROUPS ONLY — the union,
// the lookup set, and the UI all follow from it.
//
// "view all" vs "view own": "view own" scopes a user to records tied to
// the sales rep they're linked to (User.salesRepId → Customer.salesRepId);
// "view all" overrides it. See lib/permissions/scope.ts.
// =============================================================================

export type PermissionDef = {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
};

export type PermissionGroup = {
  readonly id: string;
  readonly module: string;
  readonly permissions: readonly PermissionDef[];
};

export const PERMISSION_GROUPS = [
  {
    id: 'customers',
    module: 'Customers',
    permissions: [
      { key: 'customers.view_all', label: 'View all', hint: 'See every customer.' },
      { key: 'customers.view_own', label: 'View own', hint: 'See only customers assigned to this user as sales rep.' },
      { key: 'customers.create', label: 'Create' },
      { key: 'customers.edit', label: 'Edit' },
      { key: 'customers.delete', label: 'Delete' },
    ],
  },
  {
    id: 'sales_orders',
    module: 'Sales Orders',
    permissions: [
      { key: 'sales_orders.view_all', label: 'View all' },
      { key: 'sales_orders.view_own', label: 'View own', hint: 'See only SOs for the user’s assigned customers.' },
      { key: 'sales_orders.create', label: 'Create' },
      { key: 'sales_orders.edit', label: 'Edit' },
      { key: 'sales_orders.cancel', label: 'Cancel' },
      { key: 'sales_orders.change_price', label: 'Change price' },
      { key: 'sales_orders.override_credit_limit', label: 'Override credit limit' },
    ],
  },
  {
    id: 'products',
    module: 'Products',
    permissions: [
      { key: 'products.view', label: 'View' },
      { key: 'products.create', label: 'Create' },
      { key: 'products.edit', label: 'Edit' },
      { key: 'products.delete', label: 'Delete' },
    ],
  },
  {
    id: 'inventory',
    module: 'Inventory',
    permissions: [
      { key: 'inventory.view', label: 'View' },
      { key: 'inventory.adjust', label: 'Adjust' },
      { key: 'inventory.transfer', label: 'Transfer' },
    ],
  },
  {
    id: 'vendors',
    module: 'Vendors / POs',
    permissions: [
      { key: 'vendors.view', label: 'View' },
      { key: 'vendors.create', label: 'Create' },
      { key: 'vendors.edit', label: 'Edit' },
      { key: 'vendors.receive', label: 'Receive' },
    ],
  },
  {
    id: 'bills',
    module: 'Bills / AP',
    permissions: [
      { key: 'bills.view', label: 'View' },
      { key: 'bills.create', label: 'Create' },
      { key: 'bills.confirm', label: 'Confirm' },
      { key: 'bills.void', label: 'Void' },
      { key: 'bills.record_payment', label: 'Record payment' },
    ],
  },
  {
    id: 'invoices',
    module: 'Invoices / AR',
    permissions: [
      { key: 'invoices.view', label: 'View' },
      { key: 'invoices.send', label: 'Send' },
      { key: 'invoices.void', label: 'Void' },
      { key: 'invoices.refund', label: 'Refund' },
      { key: 'invoices.issue_credit_memo', label: 'Issue credit memo' },
    ],
  },
  {
    id: 'rmas',
    module: 'RMAs',
    permissions: [
      { key: 'rmas.view', label: 'View' },
      { key: 'rmas.approve', label: 'Approve' },
      { key: 'rmas.reject', label: 'Reject' },
      { key: 'rmas.receive', label: 'Receive' },
      { key: 'rmas.inspect', label: 'Inspect' },
    ],
  },
  {
    id: 'credit_memos',
    module: 'Credit Memos',
    permissions: [
      { key: 'credit_memos.view', label: 'View' },
      { key: 'credit_memos.create', label: 'Create' },
      { key: 'credit_memos.confirm', label: 'Confirm' },
      { key: 'credit_memos.void', label: 'Void' },
    ],
  },
  {
    id: 'payments',
    module: 'Payments',
    permissions: [
      { key: 'payments.view', label: 'View' },
      { key: 'payments.record', label: 'Record' },
      { key: 'payments.reverse', label: 'Reverse' },
      { key: 'payments.apply', label: 'Apply' },
    ],
  },
  {
    id: 'gl',
    module: 'GL',
    permissions: [
      { key: 'gl.view', label: 'View' },
      { key: 'gl.post_manual_je', label: 'Post manual JE' },
      { key: 'gl.close_period', label: 'Close period' },
    ],
  },
  {
    id: 'reports',
    module: 'Reports',
    permissions: [
      { key: 'reports.view_financial', label: 'View financial' },
      { key: 'reports.view_operational', label: 'View operational' },
      { key: 'reports.build_custom', label: 'Build custom' },
    ],
  },
  {
    id: 'admin',
    module: 'Admin',
    permissions: [
      { key: 'admin.edit_settings', label: 'Edit settings' },
      { key: 'admin.edit_coa', label: 'Edit chart of accounts' },
      { key: 'admin.edit_users', label: 'Edit users' },
      { key: 'admin.edit_roles', label: 'Edit roles' },
      { key: 'admin.view_audit_log', label: 'View audit log' },
    ],
  },
  {
    id: 'work_orders',
    module: 'Work Orders',
    permissions: [
      { key: 'work_orders.view', label: 'View' },
      { key: 'work_orders.create', label: 'Create' },
      { key: 'work_orders.start', label: 'Start' },
      { key: 'work_orders.complete', label: 'Complete' },
      { key: 'work_orders.cancel', label: 'Cancel' },
    ],
  },
  {
    id: 'inventory_adjustments',
    module: 'Inventory Adjustments',
    permissions: [
      { key: 'inventory_adjustments.view', label: 'View' },
      { key: 'inventory_adjustments.create', label: 'Create' },
      { key: 'inventory_adjustments.void', label: 'Void' },
    ],
  },
] as const satisfies readonly PermissionGroup[];

// Derive the PermissionKey union from the literal keys above. Adding a
// permission to PERMISSION_GROUPS widens this union automatically.
type Groups = typeof PERMISSION_GROUPS;
type GroupPermission<G> = G extends { permissions: readonly (infer P)[] } ? P : never;
type PermissionKeyOf<P> = P extends { key: infer K } ? K : never;
export type PermissionKey = PermissionKeyOf<GroupPermission<Groups[number]>>;

// A role's permission grant: a sparse map of granted keys. An absent key
// (or a non-true value) means "not granted".
export type PermissionMap = Partial<Record<PermissionKey, boolean>>;

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_GROUPS.flatMap(
  (g) => g.permissions.map((p) => p.key),
) as PermissionKey[];

const KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);

export function isPermissionKey(s: string): s is PermissionKey {
  return KEY_SET.has(s);
}

// view-all / view-own pairs used by the scope resolver. Kept here so the
// scoping code references catalog constants rather than magic strings.
export const SCOPE_PAIRS = {
  customers: { all: 'customers.view_all', own: 'customers.view_own' },
  salesOrders: { all: 'sales_orders.view_all', own: 'sales_orders.view_own' },
} as const satisfies Record<string, { all: PermissionKey; own: PermissionKey }>;

/**
 * Coerce arbitrary JSON (e.g. from Role.permissions or a form payload)
 * into a clean PermissionMap: only known keys, only `true` values are
 * kept. Unknown keys are dropped so a stale/typo'd key can never silently
 * grant access, and `false` values are normalized to absent.
 */
export function sanitizePermissionMap(input: unknown): PermissionMap {
  const out: PermissionMap = {};
  if (input == null || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === true && isPermissionKey(k)) out[k] = true;
  }
  return out;
}

export function countGranted(map: PermissionMap): number {
  return Object.values(map).filter((v) => v === true).length;
}
