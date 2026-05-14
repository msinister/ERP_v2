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
  FileText,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  superAdminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Customers', href: '/customers', icon: Users },
  { label: 'Sales Orders', href: '/sales-orders', icon: ShoppingCart },
  { label: 'Products', href: '/products', icon: Package },
  { label: 'Vendors', href: '/vendors', icon: Building2 },
  { label: 'Purchase Orders', href: '/purchase-orders', icon: Truck },
  { label: 'Bills & AP', href: '/bills', icon: FileText },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Admin', href: '/admin', icon: Settings, superAdminOnly: true },
];

export function SidebarNav({
  isSuperAdmin,
  onNavigate,
}: {
  isSuperAdmin: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => !i.superAdminOnly || isSuperAdmin);

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
