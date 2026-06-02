import { redirect } from 'next/navigation';
import { marked } from 'marked';
import { db } from '@/lib/db';
import { getActor } from '@/lib/permissions/getActor';
import { listPublishedEntries } from '@/server/services/changelog';
import { WhatsNewPage as WhatsNewPageClient } from './_client';

export const revalidate = 0;

export default async function WhatsNewPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');

  const [entries, reads] = await Promise.all([
    listPublishedEntries(db),
    db.userChangelogRead.findMany({
      where: { userId: actor.id },
      select: { changelogEntryId: true },
    }),
  ]);

  const readSet = new Set(reads.map((r) => r.changelogEntryId));

  const serialized = entries.map((e) => ({
    id: e.id,
    version: e.version,
    title: e.title,
    descriptionHtml: marked.parse(e.description) as string,
    type: e.type,
    publishedAt: e.publishedAt!.toISOString(),
    isRead: readSet.has(e.id),
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">What&rsquo;s New</h1>
        <p className="text-sm text-muted-foreground">
          Release notes and updates for ERP v2.
        </p>
      </div>
      <WhatsNewPageClient entries={serialized} />
    </div>
  );
}
