import type { AuditContext } from '@/lib/audit/audit';
import type { AuthedUser } from './getCurrentUser';

// =============================================================================
// Build an AuditContext from an authenticated request. Wires userId +
// ipAddress (with proxy-header precedence) into every audit row written
// downstream by the service layer.
//
// IP source precedence:
//   1. x-forwarded-for         — front-end LB / reverse proxy
//   2. x-real-ip               — common alternate name
//   3. cf-connecting-ip        — Cloudflare
//
// If x-forwarded-for is a comma-separated list, we take the LEFTMOST
// entry (the original client). This is correct only when the proxy
// chain is trusted — DigitalOcean App Platform sets x-forwarded-for to
// the real client IP for us, so this works for the pilot deployment.
// If we ever sit behind an untrusted intermediary, we'll need to make
// the trusted-proxy count configurable.
//
// `reason` is left null here — services that need a justification (void
// invoice, hard delete, etc.) layer their own reason on top via the
// `ctx: { ...auditCtxFromRequest(req, user), reason: ... }` pattern.
// =============================================================================

const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'] as const;

function extractIpAddress(req: Request): string | null {
  for (const header of IP_HEADERS) {
    const raw = req.headers.get(header);
    if (!raw) continue;
    // x-forwarded-for is comma-separated; first entry is the original
    // client (leftmost-wins under a trusted-proxy chain).
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

export function auditCtxFromRequest(
  req: Request,
  user: AuthedUser,
): AuditContext {
  return {
    userId: user.id,
    ipAddress: extractIpAddress(req),
    reason: null,
  };
}
