import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import {
  PREFERENCE_SCHEMAS,
  isPreferenceKey,
} from '@/lib/validation/preferences';
import { setUserPreference } from '@/server/services/userPreferences';
import type { Prisma } from '@/generated/tenant';

// PUT /api/me/preferences  { key, value } → upsert the current user's UI
// preference for that key. The key must be a registered preference key and
// the value must satisfy that key's schema (keeps junk out of the store and
// makes the endpoint reusable across list pages). Personal pref — no audit.

const bodySchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

export async function PUT(req: Request) {
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
    const { key, value } = parsed.data;
    if (!isPreferenceKey(key)) {
      return NextResponse.json({ error: `unknown preference key: ${key}` }, { status: 400 });
    }
    const valueParsed = PREFERENCE_SCHEMAS[key].safeParse(value);
    if (!valueParsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: valueParsed.error.issues },
        { status: 400 },
      );
    }
    await setUserPreference(
      db,
      user.id,
      key,
      valueParsed.data as Prisma.InputJsonValue,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
