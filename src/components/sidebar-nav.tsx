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
  Receipt,
  ArrowLeftRight,
  BookOpen,
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
import {
  permissionMapHasModule,
  type PermissionMap,
  type PermissionModuleId,
} from '@/lib/permissions/constants';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // Visible when the user holds ANY permission in this module (any
  // `${module}.*` key — view OR create/edit/etc.). Omit (Dashboard) =
  // always visible. Super Admin sees every item regardless.
  module?: PermissionModuleId;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Customers', href: '/customers', icon: Users, module: 'customers' },
  {
    label: 'Sales Orders',
    href: '/sales-orders',
    icon: ShoppingCart,
    module: 'sales_orders',
  },
  {
    label: 'Credit Memos',
    href: '/credit-memos',
    icon: Undo2,
    module: 'credit_memos',
  },
  { label: 'Payments', href: '/payments', icon: Banknote, module: 'payments' },
  { label: 'RMAs', href: '/rmas', icon: RotateCcw, module: 'rmas' },
  { label: 'Products', href: '/products', icon: Package, module: 'products' },
  {
    label: 'Inventory Adjustments',
    href: '/inventory-adjustments',
    icon: SlidersHorizontal,
    module: 'inventory',
  },
  {
    label: 'Work Orders',
    href: '/work-orders',
    icon: Wrench,
    module: 'work_orders',
  },
  { label: 'Vendors', href: '/vendors', icon: Building2, module: 'vendors' },
  {
    // POs are part of the vendor/purchasing module.
    label: 'Purchase Orders',
    href: '/purchase-orders',
    icon: Truck,
    module: 'vendors',
  },
  { label: 'Bills', href: '/bills', icon: FileText, module: 'bills' },
  {
    // Quick Expense Logger — fast credit-card / small-expense entry.
    // Part of the AP (bills) module.
    label: 'Expenses',
    href: '/expenses',
    icon: Receipt,
    module: 'bills',
  },
  {
    // Account transfers post manual JEs between money accounts — GL module.
    label: 'Transfers',
    href: '/transfers',
    icon: ArrowLeftRight,
    module: 'gl',
  },
  {
    // Per-account transaction register (cash / credit-card focus).
    label: 'GL Ledger',
    href: '/gl-ledger',
    icon: BookOpen,
    module: 'gl',
  },
  {
    // Vendor credits are part of the AP (bills) module.
    label: 'Vendor Credits',
    href: '/vendor-credits',
    icon: CreditCard,
    module: 'bills',
  },
  { label: 'Reports', href: '/reports', icon: BarChart3, module: 'reports' },
  { label: 'Admin', href: '/admin', icon: Settings, module: 'admin' },
];

// UX-only visibility check (the security boundary is the page/route, not
// this). No module → always shown; Super Admin → everything; otherwise the
// user must hold ANY permission in the item's module.
function canSee(
  item: NavItem,
  isSuperAdmin: boolean,
  permissions: PermissionMap,
): boolean {
  if (!item.module) return true;
  if (isSuperAdmin) return true;
  return permissionMapHasModule(permissions, item.module);
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
