import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { searchTags } from '@/server/services/customerTags';

// Autocomplete endpoint — searches across the global tag dictionary,
// not scoped to a single customer.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '25') || 25, 100);
  const tags = await searchTags(db, q, limit);
  return NextResponse.json(tags);
}
