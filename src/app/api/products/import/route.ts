import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  importProductRows,
  IMPORT_MAX_BATCH,
  type ImportRowInput,
} from '@/server/services/productImport';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// One batch per request. The client chunks the file into batches of 50 and
// POSTs them sequentially (drives the progress bar + keeps each request
// small enough to avoid timeouts). The cap here is a defensive ceiling.
const rowSchema = z.object({
  rowNumber: z.number().int(),
  sku: z.string().optional(),
  name: z.string().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  basePrice: z.string().optional(),
  weight: z.string().optional(),
  weightUnit: z.string().optional(),
  lengthDim: z.string().optional(),
  widthDim: z.string().optional(),
  heightDim: z.string().optional(),
  dimensionUnit: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  hsCode: z.string().optional(),
  hazmat: z.string().optional(),
  active: z.string().optional(),
  type: z.string().optional(),
});

const bodySchema = z.object({
  mode: z.enum(['skip', 'update']),
  rows: z.array(rowSchema).min(1).max(IMPORT_MAX_BATCH),
});

export async function POST(req: Request) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const results = await importProductRows(
      db,
      parsed.data.mode,
      parsed.data.rows as ImportRowInput[],
      auditCtx,
    );
    return NextResponse.json({ results });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
