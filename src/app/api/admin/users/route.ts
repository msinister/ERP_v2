import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuditAction, Prisma } from '@/generated/tenant';
import { auth } from '@/lib/auth/auth';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit/audit';
import { requireSuperAdmin } from '@/lib/auth/requireAuth';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { authErrorResponse } from '@/lib/auth/errors';
import { decimalString } from '@/lib/validation/common';
import { linkUserAsSalesRep } from '@/server/services/salesReps';

// Password policy mirrors scripts/create-first-super-admin.ts. Spec
// (docs/09-admin.md): 8+ chars, upper + lower + digit + special.
const PASSWORD_RE = {
  minLength: /.{8,}/,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  digit: /\d/,
  special: /[^A-Za-z0-9]/,
};

function validatePassword(password: string): string | null {
  if (!PASSWORD_RE.minLength.test(password)) return 'must be at least 8 characters';
  if (!PASSWORD_RE.upper.test(password)) return 'must include an uppercase letter';
  if (!PASSWORD_RE.lower.test(password)) return 'must include a lowercase letter';
  if (!PASSWORD_RE.digit.test(password)) return 'must include a digit';
  if (!PASSWORD_RE.special.test(password)) return 'must include a special character';
  return null;
}

const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(256),
  name: z.string().min(1).max(255),
  isSuperAdmin: z.boolean().optional(),
  forcePasswordReset: z.boolean().optional(),
  // "Also create as sales rep" — when present, a linked SalesRep is created
  // in the same operation. Code is auto-suggested client-side but editable;
  // omitted code falls back to a server-generated one.
  salesRep: z
    .object({
      code: z.string().min(1).max(64).optional(),
      commissionEnabled: z.boolean().optional(),
      commissionBasis: z.enum(['REVENUE', 'MARGIN']).nullable().optional(),
      commissionPercent: decimalString
        .refine((v) => Number(v) >= 0, 'Must be >= 0')
        .nullable()
        .optional(),
    })
    .optional(),
});

export async function GET(req: Request) {
  try {
    await requireSuperAdmin(req);
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? undefined;
    const role = url.searchParams.get('role') ?? undefined; // super | regular
    const enabledRaw = url.searchParams.get('enabled');
    const enabled =
      enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined;
    const skip = Number(url.searchParams.get('skip') ?? '0') || 0;
    const take = Math.min(
      Number(url.searchParams.get('take') ?? '100') || 100,
      500,
    );

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(role === 'super'
        ? { isSuperAdmin: true }
        : role === 'regular'
          ? { isSuperAdmin: false }
          : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          isSuperAdmin: true,
          enabled: true,
          forcePasswordReset: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      db.user.count({ where }),
    ]);
    return NextResponse.json({ rows, total });
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
    const actor = await requireSuperAdmin(req);
    const auditCtx = auditCtxFromRequest(req, actor);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { email, password, name, isSuperAdmin, forcePasswordReset, salesRep } =
      parsed.data;

    const policy = validatePassword(password);
    if (policy) {
      return NextResponse.json(
        { error: `password ${policy}` },
        { status: 400 },
      );
    }

    // Pre-check the explicit rep code BEFORE creating the auth account, so a
    // collision doesn't leave a user behind with no rep. Auto-generated
    // codes (no code supplied) can't collide.
    if (salesRep?.code) {
      const existingRep = await db.salesRep.findUnique({
        where: { code: salesRep.code.trim().toUpperCase() },
        select: { id: true },
      });
      if (existingRep) {
        return NextResponse.json(
          { error: 'A sales rep with this code already exists' },
          { status: 409 },
        );
      }
    }

    // BetterAuth's signUpEmail is the canonical way to create a
    // credential account — it owns password hashing. Public sign-up
    // is gated at the edge (middleware.ts); server-side calls work
    // even when disableSignUp would normally apply. Same pattern as
    // scripts/create-first-super-admin.ts.
    const result = await auth.api.signUpEmail({
      body: { email, password, name },
    });
    const userId = result?.user?.id;
    if (!userId) {
      return NextResponse.json(
        { error: 'signUpEmail did not return a user id' },
        { status: 500 },
      );
    }

    // Apply post-signup flags. signUpEmail uses BetterAuth defaults
    // (isSuperAdmin=false, forcePasswordReset=false), so we only
    // update when the admin asked for a non-default.
    const updateData: Prisma.UserUpdateInput = {};
    if (isSuperAdmin) updateData.isSuperAdmin = true;
    if (forcePasswordReset) updateData.forcePasswordReset = true;
    if (Object.keys(updateData).length > 0) {
      await db.user.update({ where: { id: userId }, data: updateData });
    }

    const after = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
        enabled: true,
        forcePasswordReset: true,
        createdAt: true,
      },
    });

    await audit(db, {
      action: AuditAction.CREATE,
      entityType: 'User',
      entityId: userId,
      after: {
        email: after.email,
        name: after.name,
        isSuperAdmin: after.isSuperAdmin,
        enabled: after.enabled,
        forcePasswordReset: after.forcePasswordReset,
      },
      ctx: auditCtx,
    });

    // Create + link the SalesRep in the same operation when requested. Its
    // own tx writes the SalesRep CREATE + User link audit rows.
    if (salesRep) {
      await linkUserAsSalesRep(
        db,
        userId,
        {
          code: salesRep.code,
          commissionEnabled: salesRep.commissionEnabled,
          commissionBasis: salesRep.commissionBasis,
          commissionPercent: salesRep.commissionPercent,
        },
        auditCtx,
      );
    }

    return NextResponse.json(after, { status: 201 });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    // BetterAuth's signUpEmail throws on duplicate email. Surface a
    // friendly message rather than a generic 400.
    const msg = e instanceof Error ? e.message : 'internal';
    if (/exists|duplicate|conflict/i.test(msg)) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
