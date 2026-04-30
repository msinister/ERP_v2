import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateGlAccountInputSchema } from '@/lib/validation/glAccounts';
import {
  getAccount,
  softDeleteAccount,
  updateAccount,
} from '@/server/services/glAccounts';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const account = await getAccount(db, id);
  if (!account) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(account);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = updateGlAccountInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const account = await updateAccount(db, id, parsed.data);
    return NextResponse.json(account);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const account = await softDeleteAccount(db, id);
    return NextResponse.json(account);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
