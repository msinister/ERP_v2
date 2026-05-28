import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  addProductImage,
  listProductImages,
} from '@/server/services/productImages';
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  isAcceptedImageMime,
  uploader,
} from '@/lib/storage/uploader';
import { requirePermission } from '@/lib/auth/requirePermission';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await requirePermission(req, 'products.view');
    const { id } = await ctx.params;
    const images = await listProductImages(db, id);
    return NextResponse.json({ images });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// Upload + create. Body: multipart/form-data with:
//   - file: the image (jpeg/png/webp/gif, <=10MB)
//   - altText: optional string
export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requirePermission(req, 'products.edit');
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
    const altRaw = form.get('altText');
    const altText =
      typeof altRaw === 'string' && altRaw.trim() !== ''
        ? altRaw.trim().slice(0, 500)
        : null;

    const upload = await uploader.uploadImage({
      buffer,
      filename: file.name || 'image',
      contentType: file.type,
      prefix: 'products',
    });
    const image = await addProductImage(
      db,
      id,
      { url: upload.url, altText },
      auditCtx,
    );
    return NextResponse.json(image, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
