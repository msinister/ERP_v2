import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createDocument } from '@/server/services/customerDocuments';
import { uploader } from '@/lib/storage/uploader';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

// Accepted MIME types for customer documents. Broader than product images
// because documents include PDFs, Word docs, etc.
const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20 MB

function isAcceptedMime(mime: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mime);
}

const FILE_DOC_KINDS = ['RESALE_PERMIT', 'BUSINESS_LICENSE', 'RESALE_CERT', 'OTHER'] as const;

const metaSchema = z.object({
  kind: z.enum(FILE_DOC_KINDS),
  expiresOn: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

// POST /api/customers/[id]/documents/file-upload
// Body: multipart/form-data with fields:
//   - file:      File blob
//   - kind:      'RESALE_PERMIT' | 'BUSINESS_LICENSE' | 'RESALE_CERT' | 'OTHER'
//   - expiresOn: ISO date string (optional)
//   - notes:     string (optional)
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;

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
      kind: form.get('kind'),
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

    const doc = await createDocument(
      db,
      id,
      {
        kind: meta.data.kind,
        storageKey: upload.url,
        fileName: upload.filename,
        contentType: upload.contentType,
        expiresOn: meta.data.expiresOn,
        notes: meta.data.notes,
      },
      auditCtx,
    );

    const { encryptedValue: _ev, encryptedValueIv: _eviv, ...rest } = doc;
    void _ev;
    void _eviv;
    return NextResponse.json(rest, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
