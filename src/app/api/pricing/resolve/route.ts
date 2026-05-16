import { NextResponse } from 'next/server';
import { Prisma } from '@/generated/tenant';
import { db } from '@/lib/db';
import { resolvePrice } from '@/lib/pricing/resolve';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// GET /api/pricing/resolve?customerId=…&variantId=…&qty=…&manualUnitPrice=…
//
// Live price preview for the SO entry form. The same resolver runs
// at create/update time — this endpoint exists so the operator sees
// the price BEFORE save without us bypassing the resolver client-side.
//
// Read-only. Wraps resolvePrice in db.$transaction because the resolver
// signature requires a Prisma.TransactionClient.

// Accept loose decimal input (".25" alongside "0.25"). Prisma.Decimal
// accepts both shapes natively, so passing the value straight through
// after this regex is safe.
const DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId');
    const variantId = url.searchParams.get('variantId');
    const qty = url.searchParams.get('qty');
    const manualUnitPriceRaw = url.searchParams.get('manualUnitPrice');

    if (!customerId || !variantId || !qty) {
      return NextResponse.json(
        { error: 'customerId, variantId, and qty are required' },
        { status: 400 },
      );
    }
    if (!DECIMAL_RE.test(qty)) {
      return NextResponse.json(
        { error: 'qty must be a non-negative decimal string' },
        { status: 400 },
      );
    }
    if (
      manualUnitPriceRaw != null &&
      manualUnitPriceRaw !== '' &&
      !DECIMAL_RE.test(manualUnitPriceRaw)
    ) {
      return NextResponse.json(
        { error: 'manualUnitPrice must be a non-negative decimal string' },
        { status: 400 },
      );
    }

    const result = await db.$transaction((tx) =>
      resolvePrice(tx, {
        customerId,
        variantId,
        qty: new Prisma.Decimal(qty),
        manualUnitPrice:
          manualUnitPriceRaw && manualUnitPriceRaw !== ''
            ? new Prisma.Decimal(manualUnitPriceRaw)
            : null,
      }),
    );
    return NextResponse.json({
      unitPrice: result.unitPrice.toString(),
      rule: result.rule,
      discountPercent: result.discountPercent?.toString() ?? null,
    });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 400 },
    );
  }
}
