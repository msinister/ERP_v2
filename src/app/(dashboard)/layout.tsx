import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { loadActor } from '@/lib/permissions/actor';
import { AppShell } from '@/components/app-shell';
import { pendingReviewCount } from '@/server/services/pendingOrderReviews';

// Auth-gated layout for the authenticated dashboard. Middleware
// short-circuits unauthenticated requests at the edge via cookie
// presence; this layout is the real session check (signature,
// expiry, user.enabled) and renders the shell chrome once the
// session is verified.
//
// We also load the actor's permission grant here (one query) so the
// sidebar can hide links the user can't access. getCurrentUser supplies
// the display fields (name/email) for the user menu; loadActor adds the
// permission map. A null actor means the row vanished mid-session →
// treat as logged out.

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const actor = await loadActor(db, user.id);
  if (!actor) redirect('/login');

  // Sidebar badge counts. Fetched here (one query) so every page in the
  // dashboard sees the same number without each having to query. Pending
  // review count drives the badge next to "Pending Orders". Cheap
  // count() — fine to run on every navigation; no caching needed.
  const pendingOrders = await pendingReviewCount(db);
  const badgeCounts = { '/admin/pending-orders': pendingOrders };

  return (
    <AppShell
      user={user}
      permissions={actor.permissions}
      badgeCounts={badgeCounts}
    >
      {children}
    </AppShell>
  );
}
