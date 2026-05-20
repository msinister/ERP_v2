import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  listProductsForExport,
  type ProductStatusFilter,
} from '@/server/services/products';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Returns ALL products matching the list filters (status / brand / category /
// search) as JSON. The client formats the CSV (papaparse unparse) so no
// server-side CSV generation is needed. Decimals are stringified for a
// lossless round-trip back through the importer.
function isStatus(v: string | null): v is ProductStatusFilter {
  return v === 'active' || v === 'all' || v === 'archived';
}

export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const url = new URL(req.url);
    const statusRaw = url.searchParams.get('status');
    const status: ProductStatusFilter = isStatus(statusRaw) ? statusRaw : 'active';
    const q = url.searchParams.get('q') ?? undefined;
    const brand = url.searchParams.get('brand') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;

    const rows = await listProductsForExport(db, { q, status, brand, category });
    const products = rows.map((p) => ({
      sku: p.sku,
      name: p.name,
      shortDescription: p.shortDescription,
      longDescription: p.longDescription,
      brand: p.brand,
      category: p.category,
      basePrice: p.basePrice?.toString() ?? null,
      weight: p.weight?.toString() ?? null,
      weightUnit: p.weightUnit,
      lengthDim: p.lengthDim?.toString() ?? null,
      widthDim: p.widthDim?.toString() ?? null,
      heightDim: p.heightDim?.toString() ?? null,
      dimensionUnit: p.dimensionUnit,
      countryOfOrigin: p.countryOfOrigin,
      hsCode: p.hsCode,
      hazmat: p.hazmat,
      active: p.active,
      type: p.type,
      imageUrl: p.imageUrl,
    }));
    return NextResponse.json({ products });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
