import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { marked } from 'marked';
import { db } from '@/lib/db';
import { getActor } from '@/lib/permissions/getActor';
import { hasPermission } from '@/lib/permissions/actor';
import { auth } from '@/lib/auth/auth';
import { listPublishedEntries } from '@/server/services/changelog';
import { ProfileCard } from './_components/profile-card';
import { ChangePasswordCard } from './_components/change-password-card';
import { SessionsCard } from './_components/sessions-card';
import { TablePreferencesCard } from './_components/table-preferences-card';
import { ActivityCard } from './_components/activity-card';
import { CommissionCard } from './_components/commission-card';
import { WhatsNewCard } from './_components/whats-new-card';
import { AuditAction } from '@/generated/tenant';

export const revalidate = 0;

export default async function AccountPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');

  const hdrs = await headers();
  const currentSession = await auth.api.getSession({ headers: hdrs });
  const currentSessionId = currentSession?.session.id ?? null;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const showCommissions =
    !!actor.salesRepId && hasPermission(actor, 'commissions.view_own');

  const [profile, sessions, recentActivity, prefCount, commissionData, changelogEntries, changelogReads] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        phone: true,
        title: true,
        department: true,
        lastLoginAt: true,
        createdAt: true,
        salesRepId: true,
        salesRep: {
          select: {
            name: true,
            commissionEnabled: true,
            commissionBasis: true,
            commissionPercent: true,
          },
        },
        role: { select: { name: true } },
      },
    }),
    db.session.findMany({
      where: { userId: actor.id, expiresAt: { gt: now } },
      select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    db.auditLog.findMany({
      where: { userId: actor.id },
      select: { id: true, action: true, entityType: true, entityId: true, createdAt: true, ipAddress: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.userPreference.count({ where: { userId: actor.id } }),
    showCommissions
      ? db.commissionAccrual.findMany({
          where: {
            salesRepId: actor.salesRepId!,
            accruedAt: { gte: startOfMonth },
          },
          select: {
            id: true,
            amount: true,
            basis: true,
            accruedAt: true,
            invoice: { select: { id: true, number: true } },
          },
          orderBy: { accruedAt: 'desc' },
        })
      : Promise.resolve(null),
    listPublishedEntries(db),
    db.userChangelogRead.findMany({
      where: { userId: actor.id },
      select: { changelogEntryId: true },
    }),
  ]);

  // Serialize Decimal fields for client components (JSON can't carry Prisma Decimal)
  const serializedSessions = sessions.map((s) => ({
    ...s,
    isCurrent: s.id === currentSessionId,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }));

  const serializedActivity = recentActivity.map((e) => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
  }));

  const serializedProfile = {
    ...profile,
    image: profile.image ?? null,
    phone: profile.phone ?? null,
    title: profile.title ?? null,
    department: profile.department ?? null,
    lastLoginAt: profile.lastLoginAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    salesRep: profile.salesRep
      ? {
          ...profile.salesRep,
          commissionPercent: profile.salesRep.commissionPercent?.toString() ?? null,
        }
      : null,
  };

  const loginHistory = recentActivity
    .filter((e) => e.action === AuditAction.LOGIN)
    .slice(0, 10)
    .map((e) => ({
      id: e.id,
      createdAt: e.createdAt.toISOString(),
      ipAddress: e.ipAddress ?? null,
    }));

  let serializedCommission = null;
  if (commissionData) {
    const earned = commissionData
      .filter((a) => Number(a.amount) > 0)
      .reduce((s, a) => s + Number(a.amount), 0);
    const reversed = commissionData
      .filter((a) => Number(a.amount) < 0)
      .reduce((s, a) => s + Number(a.amount), 0);
    serializedCommission = {
      earned,
      reversed: Math.abs(reversed),
      net: earned + reversed,
      period: { year: now.getFullYear(), month: now.getMonth() },
      accrualCount: commissionData.length,
      basis: profile.salesRep?.commissionBasis ?? null,
      percent: profile.salesRep?.commissionPercent?.toString() ?? null,
    };
  }

  const changelogReadSet = new Set(changelogReads.map((r) => r.changelogEntryId));
  const serializedChangelog = changelogEntries.map((e) => ({
    id: e.id,
    version: e.version,
    title: e.title,
    descriptionHtml: marked.parse(e.description) as string,
    type: e.type,
    publishedAt: e.publishedAt!.toISOString(),
    isRead: changelogReadSet.has(e.id),
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Account</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, security, and preferences.
        </p>
      </div>

      <WhatsNewCard entries={serializedChangelog} />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left column */}
        <div className="space-y-6">
          <ProfileCard profile={serializedProfile} />
          <ChangePasswordCard />
          {serializedCommission && (
            <CommissionCard data={serializedCommission} />
          )}
        </div>

        {/* Right column */}
        <div className="space-y-6">
          <SessionsCard
            sessions={serializedSessions}
            loginHistory={loginHistory}
          />
          <TablePreferencesCard prefCount={prefCount} />
          <ActivityCard entries={serializedActivity} />
        </div>
      </div>
    </div>
  );
}
