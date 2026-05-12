import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { AppShell } from '@/components/app-shell';

// Auth-gated layout for the authenticated dashboard. Middleware
// short-circuits unauthenticated requests at the edge via cookie
// presence; this layout is the real session check (signature,
// expiry, user.enabled) and renders the shell chrome once the
// session is verified.

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return <AppShell user={user}>{children}</AppShell>;
}
