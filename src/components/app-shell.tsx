'use client';

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
import { SidebarNav } from '@/components/sidebar-nav';
import { UserMenu } from '@/components/user-menu';
import { Toaster } from '@/components/ui/sonner';
import type { AuthedUser } from '@/lib/auth/getCurrentUser';
import type { PermissionMap } from '@/lib/permissions/constants';

export function AppShell({
  user,
  permissions,
  children,
}: {
  user: AuthedUser;
  // The current user's permission grant — drives sidebar visibility.
  permissions: PermissionMap;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar — fixed 256px column on md+ */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
            ERP
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav
            isSuperAdmin={user.isSuperAdmin}
            permissions={permissions}
          />
        </div>
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
              <SheetContent side="left" className="p-0">
                <SheetHeader className="border-b border-sidebar-border">
                  <SheetTitle>ERP</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto bg-sidebar">
                  <SidebarNav
                    isSuperAdmin={user.isSuperAdmin}
                    permissions={permissions}
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
