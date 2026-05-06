import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth/auth';

// BetterAuth's catch-all route handler. Wires every endpoint
// BetterAuth ships (sign-in, sign-out, session, etc.) under
// /api/auth/*. The matcher in src/middleware.ts must always
// allow /api/auth/* to pass through unauthenticated.

export const { GET, POST } = toNextJsHandler(auth.handler);
