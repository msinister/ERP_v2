import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  clearVariantImage,
  setVariantImage,
} from '@/server/services/productImages';
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  isAcceptedImageMime,
  uploader,
} from '@/lib/storage/uploader';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

// POST: upload + set the variant's image (single image, no gallery —
// see schema comment on ProductVariant.imageUrl).
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
    if (!isAcceptedImageMime(file.type)) {
      return NextResponse.json(
        {
          error: `unsupported image type ${file.type}; accepted: ${IMAGE_MIME_TYPES.join(', ')}`,
        },
        { status: 415 },
      );
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          error: `file too large (${file.size} bytes); max ${MAX_IMAGE_BYTES}`,
        },
        { status: 413 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const upload = await uploader.uploadImage({
      buffer,
      filename: file.name || 'image',
      contentType: file.type,
      prefix: 'variants',
    });
    const variant = await setVariantImage(db, id, upload.url, auditCtx);
    return NextResponse.json(variant);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const user = await requireAuth(req);
    const auditCtx = auditCtxFromRequest(req, user);
    const { id } = await ctx.params;
    const variant = await clearVariantImage(db, id, auditCtx);
    return NextResponse.json(variant);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
