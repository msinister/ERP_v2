import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';

// Returns which of the supplied SKUs already exist (non-deleted). Used by
// the import wizard's validation step to flag existing rows. Bounded to the
// import row cap so a malformed request can't fan out unboundedly.
const bodySchema = z.object({
  skus: z.array(z.string()).max(5000),
});

export async function POST(req: Request) {
  try {
    await requireAuth(req);
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
    // De-dupe + drop blanks before the IN query.
    const skus = Array.from(
      new Set(parsed.data.skus.map((s) => s.trim()).filter(Boolean)),
    );
    const rows =
      skus.length > 0
        ? await db.product.findMany({
            where: { sku: { in: skus }, deletedAt: null },
            select: { sku: true },
          })
        : [];
    return NextResponse.json({ existing: rows.map((r) => r.sku) });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
