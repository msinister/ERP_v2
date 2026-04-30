import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  getDocumentMetadata,
  softDeleteDocument,
} from '@/server/services/customerDocuments';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  const { did } = await ctx.params;
  const doc = await getDocumentMetadata(db, did);
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(doc);
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; did: string }> },
) {
  const { did } = await ctx.params;
  try {
    const doc = await softDeleteDocument(db, did);
    // Same defense-in-depth strip on response.
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
