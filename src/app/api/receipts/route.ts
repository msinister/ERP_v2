import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ReceiptStatus } from '@/generated/tenant';
import { createReceiptInputSchema } from '@/lib/validation/receipts';
import { createDraftReceipt, listReceipts } from '@/server/services/receipts';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendorId = url.searchParams.get('vendorId') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && statusParam in ReceiptStatus
      ? (statusParam as ReceiptStatus)
      : undefined;
  const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
  const take = Math.min(Number(url.searchParams.get('take') ?? '100') || 100, 500);
  const list = await listReceipts(db, { vendorId, status, skip, take });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = createReceiptInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const receipt = await createDraftReceipt(db, parsed.data);
    return NextResponse.json(receipt, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
