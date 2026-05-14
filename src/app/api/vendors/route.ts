import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { VendorType } from '@/generated/tenant';
import { createVendorInputSchema } from '@/lib/validation/vendors';
import { createVendor, listVendorsPaged } from '@/server/services/vendors';
import { requireAuth } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const activeParam = url.searchParams.get('active');
    const active =
      activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;
    const typeParam = url.searchParams.get('type');
    const type =
      typeParam && typeParam in VendorType
        ? (typeParam as VendorType)
        : undefined;
    const q = url.searchParams.get('q') ?? undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(
      Number(url.searchParams.get('take') ?? '100') || 100,
      500,
    );

    const page = await listVendorsPaged(db, { active, type, q, skip, take });
    return NextResponse.json(page);
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}

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
    const parsed = createVendorInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const vendor = await createVendor(db, parsed.data, auditCtx);
    return NextResponse.json(vendor, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
