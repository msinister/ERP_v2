import type { Actor } from '@/lib/permissions/actor';
import type { PermissionKey } from '@/lib/permissions/constants';

export type WidgetDef = {
  id: string;
  label: string;
  colSpan?: 2;
  defaultVisible: boolean;
  permCheck: (can: (...keys: PermissionKey[]) => boolean, actor: Actor) => boolean;
};

export const WIDGET_REGISTRY: WidgetDef[] = [
  {
    id: 'todays-sales',
    label: "Today's Sales",
    defaultVisible: true,
    permCheck: (can) => can('sales_orders.view_all', 'sales_orders.view_own'),
  },
  {
    id: 'sales-by-rep',
    label: 'Sales by Rep',
    colSpan: 2,
    defaultVisible: true,
    permCheck: (can) => can('sales_orders.view_all'),
  },
  {
    id: 'ar-aging',
    label: 'AR Aging',
    defaultVisible: true,
    permCheck: (can) => can('sales_orders.view_all', 'sales_orders.view_own'),
  },
  {
    id: 'ap-aging',
    label: 'AP Aging',
    defaultVisible: true,
    permCheck: (can) => can('bills.view'),
  },
  {
    id: 'open-sos',
    label: 'Open Sales Orders',
    defaultVisible: true,
    permCheck: (can) => can('sales_orders.view_all', 'sales_orders.view_own'),
  },
  {
    id: 'open-pos',
    label: 'Open Purchase Orders',
    defaultVisible: true,
    permCheck: (can) => can('vendors.view'),
  },
  {
    id: 'low-stock',
    label: 'Low Stock Alerts',
    defaultVisible: true,
    permCheck: (can) => can('inventory.view'),
  },
  {
    id: 'unapplied-payments',
    label: 'Unapplied Payments',
    defaultVisible: true,
    permCheck: (can) => can('payments.view_all', 'payments.view_own'),
  },
  {
    id: 'recent-activity',
    label: 'Recent Activity',
    defaultVisible: true,
    permCheck: (can) => can('admin.view_audit_log'),
  },
  {
    id: 'cash-position',
    label: 'Cash Position',
    defaultVisible: true,
    permCheck: (can) => can('gl.view'),
  },
  {
    id: 'pending-reviews',
    label: 'Pending Order Reviews',
    defaultVisible: true,
    permCheck: (_can, actor) => actor.isSuperAdmin,
  },
];

export const DEFAULT_ORDER = WIDGET_REGISTRY.map((w) => w.id);

export const WIDGET_REGISTRY_MAP = new Map(WIDGET_REGISTRY.map((w) => [w.id, w]));
