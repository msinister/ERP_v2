import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { markAsRead } from '@/server/services/changelog';

const bodySchema = z.object({
  entryIds: z.array(z.string()).max(500),
});

// POST /api/changelog/read — mark a batch of changelog entries as read for the
// current user. Fire-and-forget from the client on page/card mount.
export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation' }, { status: 400 });
    }
    await markAsRead(db, user.id, parsed.data.entryIds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
