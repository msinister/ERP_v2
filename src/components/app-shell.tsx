'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SidebarNav, type SidebarBadgeCounts } from '@/components/sidebar-nav';
import { UserMenu, UserAvatar } from '@/components/user-menu';
import { Toaster } from '@/components/ui/sonner';
import type { AuthedUser } from '@/lib/auth/getCurrentUser';
import type { PermissionMap } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';
import { usePathname } from 'next/navigation';
import { APP_VERSION } from '@/lib/version';

function getInitials(name: string, email: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return (email?.[0] ?? '?').toUpperCase();
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function SidebarUserSection({
  user,
  onNavigate,
}: {
  user: AuthedUser;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const display = user.name?.trim() ? user.name : user.email;
  const initials = getInitials(user.name ?? '', user.email);
  const active = pathname === '/account' || pathname.startsWith('/account/');

  return (
    <div className="border-t border-sidebar-border p-3">
      <Link
        href="/account"
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          active && 'bg-sidebar-accent text-sidebar-accent-foreground',
        )}
      >
        <UserAvatar name={display} image={user.image} initials={initials} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{display}</div>
          {user.name?.trim() && (
            <div className="truncate text-xs text-sidebar-foreground/50">{user.email}</div>
          )}
        </div>
      </Link>
    </div>
  );
}

export function AppShell({
  user,
  permissions,
  badgeCounts,
  children,
}: {
  user: AuthedUser;
  permissions: PermissionMap;
  badgeCounts?: SidebarBadgeCounts;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar — fixed 256px column on md+ */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              ERP
            </span>
            <span className="text-[10px] text-sidebar-foreground/40">v{APP_VERSION}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav
            isSuperAdmin={user.isSuperAdmin}
            permissions={permissions}
            badgeCounts={badgeCounts}
          />
        </div>
        <SidebarUserSection user={user} />
      </aside>

      {/* Right column: top bar + main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {/* Mobile hamburger — opens left-side Sheet drawer */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open navigation"
                    className="md:hidden"
                  />
                }
              >
                <Menu />
              </SheetTrigger>
              <SheetContent side="left" className="flex flex-col gap-0 p-0">
                <SheetHeader className="border-b border-sidebar-border">
                  <SheetTitle>ERP</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto bg-sidebar">
                  <SidebarNav
                    isSuperAdmin={user.isSuperAdmin}
                    permissions={permissions}
                    badgeCounts={badgeCounts}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </div>
                <div className="bg-sidebar">
                  <SidebarUserSection
                    user={user}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </div>
              </SheetContent>
            </Sheet>
            {/* Breadcrumb area — wired up in a later slice */}
            <div
              id="app-breadcrumb-slot"
              className="min-w-0 truncate text-sm text-muted-foreground"
            />
          </div>
          <UserMenu user={user} />
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
      {/* Global toast outlet — mounted once at the shell level so any
          page or client component can call toast() and have it render. */}
      <Toaster richColors position="top-right" />
    </div>
  );
}
