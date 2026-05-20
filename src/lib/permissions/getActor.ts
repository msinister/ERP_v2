import 'server-only';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { loadActor, type Actor } from './actor';

// Server-component entry point for authorization. Resolves the current
// session (getCurrentUser) then loads the full Actor (role permissions +
// salesRepId) for permission checks and scope filtering inside pages.
// Returns null when there's no valid session — the dashboard layout
// already redirects unauthenticated users, so page callers can treat null
// as "redirect to login".
export async function getActor(): Promise<Actor | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return loadActor(db, user.id);
}
