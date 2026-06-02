import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { listPublishedEntries } from '@/server/services/changelog';

// GET /api/changelog — published entries with per-entry read status for the
// current user. Client uses this to render the What's New feed and drive the
// unread badge without a full page reload.
export async function GET(req: Request) {
  try {
    const user = await requireAuth(req);

    const [entries, reads] = await Promise.all([
      listPublishedEntries(db),
      db.userChangelogRead.findMany({
        where: { userId: user.id },
        select: { changelogEntryId: true },
      }),
    ]);

    const readSet = new Set(reads.map((r) => r.changelogEntryId));

    return NextResponse.json({
      entries: entries.map((e) => ({
        ...e,
        publishedAt: e.publishedAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
        isRead: readSet.has(e.id),
      })),
    });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
