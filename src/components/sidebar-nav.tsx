'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  ShoppingCart,
  Package,
  Building2,
  Truck,
  Wrench,
  FileText,
  CreditCard,
  Banknote,
  Undo2,
  RotateCcw,
  SlidersHorizontal,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PermissionKey, PermissionMap } from '@/lib/permissions/constants';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Visible when the user holds ANY of these permissions. Omit (Dashboard)
  // = always visible. Super Admin sees every item regardless.
  anyOf?: PermissionKey[];
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  {
    label: 'Customers',
    href: '/customers',
    icon: Users,
    anyOf: ['customers.view_all', 'customers.view_own'],
  },
  {
    label: 'Sales Orders',
    href: '/sales-orders',
    icon: ShoppingCart,
    anyOf: ['sales_orders.view_all', 'sales_orders.view_own'],
  },
  {
    label: 'Credit Memos',
    href: '/credit-memos',
    icon: Undo2,
    anyOf: ['credit_memos.view_all', 'credit_memos.view_own'],
  },
  {
    label: 'Payments',
    href: '/payments',
    icon: Banknote,
    anyOf: ['payments.view_all', 'payments.view_own'],
  },
  {
    label: 'RMAs',
    href: '/rmas',
    icon: RotateCcw,
    anyOf: ['rmas.view_all', 'rmas.view_own'],
  },
  {
    label: 'Products',
    href: '/products',
    icon: Package,
    anyOf: ['products.view'],
  },
  {
    label: 'Inventory Adjustments',
    href: '/inventory-adjustments',
    icon: SlidersHorizontal,
    anyOf: ['inventory.view'],
  },
  {
    label: 'Work Orders',
    href: '/work-orders',
    icon: Wrench,
    anyOf: ['work_orders.view'],
  },
  {
    label: 'Vendors',
    href: '/vendors',
    icon: Building2,
    anyOf: ['vendors.view'],
  },
  {
    // POs are part of the vendor/purchasing module.
    label: 'Purchase Orders',
    href: '/purchase-orders',
    icon: Truck,
    anyOf: ['vendors.view'],
  },
  {
    label: 'Bills',
    href: '/bills',
    icon: FileText,
    anyOf: ['bills.view'],
  },
  {
    // Vendor credits are part of the AP (bills) module.
    label: 'Vendor Credits',
    href: '/vendor-credits',
    icon: CreditCard,
    anyOf: ['bills.view'],
  },
  {
    label: 'Reports',
    href: '/reports',
    icon: BarChart3,
    anyOf: ['reports.view_financial', 'reports.view_operational'],
  },
  {
    label: 'Admin',
    href: '/admin',
    icon: Settings,
    anyOf: [
      'admin.edit_settings',
      'admin.edit_users',
      'admin.edit_roles',
      'admin.view_audit_log',
    ],
  },
];

// UX-only visibility check (the security boundary is the page/route, not
// this). No anyOf → always shown; Super Admin → everything; otherwise the
// user must hold at least one of the item's permissions.
function canSee(
  item: NavItem,
  isSuperAdmin: boolean,
  permissions: PermissionMap,
): boolean {
  if (!item.anyOf || item.anyOf.length === 0) return true;
  if (isSuperAdmin) return true;
  return item.anyOf.some((key) => permissions[key] === true);
}

export function SidebarNav({
  isSuperAdmin,
  permissions,
  onNavigate,
}: {
  isSuperAdmin: boolean;
  permissions: PermissionMap;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => canSee(i, isSuperAdmin, permissions));

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {items.map((item) => {
        const Icon = item.icon;
        // Active when the pathname matches the item exactly or sits
        // beneath it (e.g. /customers/123 highlights the Customers
        // entry). Dashboard requires exact match so deep routes don't
        // accidentally activate it.
        const active =
          item.href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname === item.href || pathname.startsWith(item.href + '/');
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              active &&
                'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
