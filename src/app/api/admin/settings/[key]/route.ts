import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setSetting, getSetting } from '@/server/services/settings';
import { settingValueSchemas } from '@/lib/validation/settings';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Generic per-key admin route. Validates the body against the
// per-key schema registered in `lib/validation/settings.ts`. The
// runtime path keeps its own per-key route (e.g.
// /api/settings/restocking-fee-default) so service code paths
// don't depend on this admin route, but the GUI uses this one for
// every setting.

export async function GET(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { key } = await ctx.params;
    const schema = settingValueSchemas.get(key);
    if (!schema) {
      return NextResponse.json(
        { error: `unknown setting key: ${key}` },
        { status: 404 },
      );
    }
    // Tolerate a missing row — surface as null so the GUI can
    // pre-fill defaults from the registry-validated empty state.
    const row = await db.setting.findUnique({ where: { key } });
    return NextResponse.json({ key, value: row?.value ?? null });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { key } = await ctx.params;
    const schema = settingValueSchemas.get(key);
    if (!schema) {
      return NextResponse.json(
        { error: `unknown setting key: ${key}` },
        { status: 404 },
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    // setSetting parses with the schema and stores the parsed result
    // — refuses to write a malformed value, writes an UPDATE audit
    // row with before/after.
    const parsed = await setSetting(db, key, body, schema, auditCtx);
    // Mirror the on-disk shape back so the GUI can confirm what
    // landed. Read-after-write to ensure denormalized fields (e.g.,
    // schema transforms) are surfaced.
    const after = await getSetting(db, key, schema);
    return NextResponse.json({ key, value: after, parsed });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
