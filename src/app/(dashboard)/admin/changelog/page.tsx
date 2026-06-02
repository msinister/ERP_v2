import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { getActor } from '@/lib/permissions/getActor';
import { listEntriesForAdmin } from '@/server/services/changelog';
import { EntriesTable } from './_components/entries-table';

export const revalidate = 0;

export default async function AdminChangelogPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.isSuperAdmin) redirect('/admin');

  const entries = await listEntriesForAdmin(db);

  const serialized = entries.map((e) => ({
    ...e,
    publishedAt: e.publishedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    createdBy: e.createdBy
      ? { name: e.createdBy.name, email: e.createdBy.email }
      : null,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Admin
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Changelog</h1>
          <p className="text-sm text-muted-foreground">
            Manage release notes shown to all users in What&rsquo;s New.
            Draft entries are only visible here.
          </p>
        </div>
      </div>

      <EntriesTable initialEntries={serialized} />
    </div>
  );
}
