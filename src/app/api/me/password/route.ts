import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { requireAuth } from '@/lib/auth/requireAuth';
import { authErrorResponse } from '@/lib/auth/errors';
import { db } from '@/lib/db';
import { auditCtxFromRequest } from '@/lib/auth/auditCtxFromRequest';
import { audit } from '@/lib/audit/audit';
import { AuditAction } from '@/generated/tenant';

const passwordSchema = z
  .string()
  .min(8, 'Must be at least 8 characters')
  .refine((v) => /[A-Z]/.test(v), 'Must include an uppercase letter')
  .refine((v) => /[a-z]/.test(v), 'Must include a lowercase letter')
  .refine((v) => /\d/.test(v), 'Must include a digit')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Must include a special character');

const bodySchema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Required'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export async function PUT(req: Request) {
  try {
    const user = await requireAuth(req);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { currentPassword, newPassword } = parsed.data;

    try {
      await auth.api.changePassword({
        body: { currentPassword, newPassword, revokeOtherSessions: false },
        headers: req.headers,
      });
    } catch (e) {
      // BetterAuth throws when the current password is incorrect
      const msg = e instanceof Error ? e.message.toLowerCase() : '';
      if (
        msg.includes('invalid') ||
        msg.includes('incorrect') ||
        msg.includes('wrong') ||
        msg.includes('password')
      ) {
        return NextResponse.json({ error: 'current_password_incorrect' }, { status: 400 });
      }
      throw e;
    }

    await audit(db, {
      action: AuditAction.UPDATE,
      entityType: 'User',
      entityId: user.id,
      after: { changed: 'password' },
      ctx: auditCtxFromRequest(req, user),
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const authResp = authErrorResponse(e);
    if (authResp) return authResp;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal' },
      { status: 500 },
    );
  }
}
