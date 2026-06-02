import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChangelogEntryType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { loadActor } from '@/lib/permissions/actor';
import { updateEntry, deleteEntry } from '@/server/services/changelog';

const updateSchema = z.object({
  version: z.string().min(1).max(20),
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  type: z.nativeEnum(ChangelogEntryType),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

// PUT /api/admin/changelog/[id] — update an entry
export async function PUT(req: Request, { params }: RouteContext) {
  try {
    const user = await requireSuperAdmin(req);
    const { id } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
    }
    const actor = await loadActor(db, user.id);
    if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    await updateEntry(db, actor, id, {
      ...parsed.data,
      publishedAt: parsed.data.publishedAt ? new Date(parsed.data.publishedAt) : null,
    }, auditCtxFromRequest(req, user));

    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    if (e instanceof Error && e.message.includes('Record to update not found')) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// DELETE /api/admin/changelog/[id] — soft delete
export async function DELETE(req: Request, { params }: RouteContext) {
  try {
    const user = await requireSuperAdmin(req);
    const { id } = await params;
    await deleteEntry(db, id, auditCtxFromRequest(req, user));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    if (e instanceof Error && e.message.includes('Record to update not found')) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
