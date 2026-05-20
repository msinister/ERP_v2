import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { searchTags } from '@/server/services/productTags';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Autocomplete the global product-tag dictionary for the inline editor.
export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const tags = await searchTags(db, q, 25);
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
