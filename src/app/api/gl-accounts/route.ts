import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createGlAccountInputSchema } from '@/lib/validation/glAccounts';
import {
  createAccount,
  listAccounts,
} from '@/server/services/glAccounts';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const activeParam = url.searchParams.get('active');
  const active =
    activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '200') || 200, 500);
  const list = await listAccounts(db, { active, skip, take });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createGlAccountInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const account = await createAccount(db, parsed.data);
    return NextResponse.json(account, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
