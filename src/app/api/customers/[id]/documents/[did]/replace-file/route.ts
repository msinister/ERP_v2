import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  getDocumentMetadata,
  updateDocument,
} from '@/server/services/customerDocuments';
import { uploader } from '@/lib/storage/uploader';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

const MAX_DOC_BYTES = 20 * 1024 * 1024;

function isAcceptedMime(mime: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mime);
}

const SENSITIVE_KINDS = new Set(['EIN', 'SSN', 'DRIVERS_LICENSE']);

const metaSchema = z.object({
  expiresOn: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});

type Ctx = { params: Promise<{ id: string; did: string }> };

// POST /api/customers/[id]/documents/[did]/replace-file
// Replaces the stored file for a file-kind document in-place (same record ID).
// Rejects if the document is a sensitive kind (EIN/SSN/DRIVERS_LICENSE).
// Body: multipart/form-data with fields:
//   - file:      File blob
//   - expiresOn: ISO date string (optional — updates the metadata too)
//   - notes:     string (optional)
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id, did } = await ctx.params;

    // Verify the document exists and is a file kind before processing the upload.
    const existing = await getDocumentMetadata(db, did);
    if (!existing) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (SENSITIVE_KINDS.has(existing.kind)) {
      return NextResponse.json(
        { error: 'use PATCH with cleartextValue to update a sensitive document' },
        { status: 400 },
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { error: 'expected multipart/form-data' },
        { status: 400 },
      );
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'file field is required' },
        { status: 400 },
      );
    }
    if (!isAcceptedMime(file.type)) {
      return NextResponse.json(
        { error: `unsupported file type: ${file.type}` },
        { status: 415 },
      );
    }
    if (file.size > MAX_DOC_BYTES) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_DOC_BYTES / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    const meta = metaSchema.safeParse({
      expiresOn: form.get('expiresOn') || undefined,
      notes: form.get('notes') || undefined,
    });
    if (!meta.success) {
      return NextResponse.json(
        { error: 'validation', issues: meta.error.issues },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const upload = await uploader.uploadImage({
      buffer,
      filename: file.name || 'document',
      contentType: file.type,
      prefix: `customers/${id}/documents`,
    });

    const updatePayload: Record<string, unknown> = {
      storageKey: upload.url,
      fileName: upload.filename,
      contentType: upload.contentType,
    };
    if (meta.data.expiresOn !== undefined) updatePayload.expiresOn = meta.data.expiresOn;
    if (meta.data.notes !== undefined) updatePayload.notes = meta.data.notes;

    const doc = await updateDocument(db, did, updatePayload, auditCtx);
    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
