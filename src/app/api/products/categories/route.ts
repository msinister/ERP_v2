import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  listProductBrands,
  listProductCategories,
} from '@/server/services/products';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Distinct existing product categories + brands. Powers the inline
// "Create product" dialog's category dropdown (and brand suggestions)
// without plumbing the lists through every form that embeds a
// VariantPicker. Pilot data volume is small enough that DISTINCT is cheap.
export async function GET(req: Request) {
  try {
    await requireAuth(req);
    const [categories, brands] = await Promise.all([
      listProductCategories(db),
      listProductBrands(db),
    ]);
    return NextResponse.json({ categories, brands });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
