import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { shopifyStoreRulesReplaceSchema } from '@/lib/validation/shopifyStores';
import {
  listRules,
  matchingProductIds,
  replaceRules,
} from '@/server/services/shopifyStoreRules';

// GET → current rules for this store + a `matchCount` preview so the UI
// can render "this rule set matches X products" live. PUT → wholesale-
// replace the rule set (atomic delete + insert).

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin(req);
    const { id } = await ctx.params;
    const [rules, matchIds] = await Promise.all([
      listRules(db, id),
      matchingProductIds(db, id),
    ]);
    return NextResponse.json({ rules, matchCount: matchIds.length });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function PUT(
  req: Request,
  routeCtx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await routeCtx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = shopifyStoreRulesReplaceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const rules = await replaceRules(db, id, parsed.data, auditCtx);
    const matchIds = await matchingProductIds(db, id);
    return NextResponse.json({ rules, matchCount: matchIds.length });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
