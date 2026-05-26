import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { searchOrderTags } from '@/server/services/orderTags';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Autocomplete the shared operational-tag dictionary for the inline editor.
// Used by Sales Order tagging today; future PO/Bill/CM/RMA/WO/VC tag UIs
// share this same endpoint (the dictionary is global).
export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const tags = await searchOrderTags(db, q, 25);
    return NextResponse.json({
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
