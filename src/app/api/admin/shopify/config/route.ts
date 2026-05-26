import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { shopifyConfigInputSchema } from '@/lib/validation/shopify';
import { getPublicConfig, saveConfig } from '@/server/services/shopifyConfig';

// GET → public-safe config snapshot (no secrets), feeds the admin form's
// defaultValues. PUT → upsert; secrets passed as empty/absent mean "leave
// alone" so the form doesn't force re-typing tokens to change a toggle.

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const cfg = await getPublicConfig(db);
    return NextResponse.json(cfg);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = shopifyConfigInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const cfg = await saveConfig(db, parsed.data, user.id);
    return NextResponse.json(cfg);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
