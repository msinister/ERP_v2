import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createDocumentInputSchema } from '@/lib/validation/customers';
import {
  createDocument,
  listDocumentsForCustomer,
} from '@/server/services/customerDocuments';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const list = await listDocumentsForCustomer(db, id);
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
  const parsed = createDocumentInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const doc = await createDocument(db, id, parsed.data);
    // Strip encrypted columns from the response — the API surface
    // never returns ciphertext to the client.
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
