import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChangelogEntryType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { loadActor } from '@/lib/permissions/actor';
import { listEntriesForAdmin, createEntry } from '@/server/services/changelog';

const createSchema = z.object({
  version: z.string().min(1).max(20),
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  type: z.nativeEnum(ChangelogEntryType),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

// GET /api/admin/changelog — all entries including drafts (super admin only)
export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const entries = await listEntriesForAdmin(db);
    return NextResponse.json({
      entries: entries.map((e) => ({
        ...e,
        publishedAt: e.publishedAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// POST /api/admin/changelog — create a new entry
export async function POST(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
    }
    const actor = await loadActor(db, user.id);
    if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const entry = await createEntry(db, actor, {
      ...parsed.data,
      publishedAt: parsed.data.publishedAt ? new Date(parsed.data.publishedAt) : null,
    }, auditCtxFromRequest(req, user));

    return NextResponse.json({ entry: { id: entry.id } }, { status: 201 });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
