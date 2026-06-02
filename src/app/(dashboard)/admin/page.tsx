import Link from 'next/link';
import {
  Users,
  Sliders,
  Landmark,
  CalendarClock,
  CalendarCheck2,
  ScrollText,
  ShieldCheck,
  BadgeDollarSign,
  ShoppingBag,
  Newspaper,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { requirePageAnyPermissionInModule } from '@/lib/permissions/requirePagePermission';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const revalidate = 0;

// Server-side super-admin gate. The sidebar already hides this entry
// for non-super users, but UI gating is never the security boundary
// (CLAUDE.md non-negotiable rule). A non-super hitting /admin by URL
// gets bounced back to the dashboard.

type AdminTile = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

const TILES: AdminTile[] = [
  {
    href: '/admin/users',
    title: 'Users',
    description: 'People with access, roles, password resets.',
    icon: Users,
  },
  {
    href: '/admin/roles',
    title: 'Roles',
    description: 'Custom permission bundles assigned to users.',
    icon: ShieldCheck,
  },
  {
    href: '/admin/sales-reps',
    title: 'Sales reps',
    description: 'Commission rate + basis; link reps to logins.',
    icon: BadgeDollarSign,
  },
  {
    href: '/admin/settings',
    title: 'Settings',
    description:
      'Restocking fee, negative inventory, tier discounts, commissions.',
    icon: Sliders,
  },
  {
    href: '/admin/gl-accounts',
    title: 'GL accounts',
    description: 'Chart of accounts — codes, types, active status.',
    icon: Landmark,
  },
  {
    href: '/admin/payment-terms',
    title: 'Payment terms',
    description:
      'Net 30, COD, Prepay — the menu vendors and customers pick from.',
    icon: CalendarClock,
  },
  {
    href: '/admin/audit-log',
    title: 'Audit log',
    description: 'Every sensitive action — filter by user, entity, date.',
    icon: ScrollText,
  },
  {
    href: '/admin/periods',
    title: 'Fiscal periods',
    description: 'Soft-close / hard-close / reopen monthly GL periods.',
    icon: CalendarCheck2,
  },
  {
    href: '/admin/shopify',
    title: 'Shopify sync',
    description:
      'Store URL, access token, webhook secret. Manual full sync + register webhooks.',
    icon: ShoppingBag,
  },
  {
    href: '/admin/warehouses',
    title: 'Warehouses',
    description: 'Physical stock locations. Set the Inventory GL Account required for COGS posting.',
    icon: Warehouse,
  },
  {
    href: '/admin/changelog',
    title: 'Changelog',
    description: "Manage What's New entries — publish features, fixes, and security updates.",
    icon: Newspaper,
  },
];

export default async function AdminPage() {
  // Any admin.* permission unlocks the index. Each tile links to a page
  // that gates itself with its own specific permission, so non-super
  // users with (say) only admin.view_audit_log land here and see every
  // tile but can only open the ones their role grants.
  await requirePageAnyPermissionInModule('admin');

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Super-admin-only console — every page here is gated server-side.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link
              key={tile.href}
              href={tile.href}
              className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Card className="h-full transition-colors group-hover:border-foreground/30">
                <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                  <Icon className="size-5 text-muted-foreground" />
                  <CardTitle className="text-sm">{tile.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {tile.description}
                  </p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
