import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createPaymentTermInputSchema } from '@/lib/validation/paymentTerms';
import {
  createPaymentTerm,
  listPaymentTerms,
} from '@/server/services/paymentTerms';

// TODO: wire requirePermission() once lib/permissions exists

export async function GET(req: Request) {
  const url = new URL(req.url);
  const activeParam = url.searchParams.get('active');
  const active =
    activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);

  const list = await listPaymentTerms(db, { active, skip, take });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createPaymentTermInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const term = await createPaymentTerm(db, parsed.data);
    return NextResponse.json(term, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
