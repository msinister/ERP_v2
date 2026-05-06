import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { searchTags } from '@/server/services/customerTags';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Autocomplete endpoint — searches across the global tag dictionary,
// not scoped to a single customer.
export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '25') || 25, 100);
    const tags = await searchTags(db, q, limit);
    return NextResponse.json(tags);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
