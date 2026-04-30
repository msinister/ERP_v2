import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { CustomerActivityKind } from '@/generated/tenant';
import { createActivityInputSchema } from '@/lib/validation/customers';
import {
  addManualEntry,
  listActivity,
} from '@/server/services/customerActivities';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const kindParam = url.searchParams.get('kind') ?? undefined;
  const fromParam = url.searchParams.get('from') ?? undefined;
  const toParam = url.searchParams.get('to') ?? undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

  const list = await listActivity(db, id, {
    kind: (kindParam as CustomerActivityKind | undefined) ?? undefined,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
    skip,
    take,
  });
  return NextResponse.json(list);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createActivityInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const entry = await addManualEntry(db, id, parsed.data);
    return NextResponse.json(entry, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
