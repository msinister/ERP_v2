'use client';

import { useEffect, useState } from 'react';

export type RepDuplicate = { id: string; code: string; name: string } | null;

// Debounced "is there already a rep with this email?" lookup, shared by the
// sales-rep form and the user-create form (where the rep inherits the user's
// email). Non-blocking — callers render an inline warning, not a hard error.
// Hits GET /api/admin/sales-reps?email=...&exclude=... which returns
// { duplicate }.
export function useRepEmailDuplicate(
  email: string,
  excludeRepId?: string,
): RepDuplicate {
  const [duplicate, setDuplicate] = useState<RepDuplicate>(null);

  useEffect(() => {
    const value = email.trim();
    // Only check once it looks like a complete address — avoids spamming the
    // endpoint on every keystroke of a half-typed email.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setDuplicate(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ email: value });
        if (excludeRepId) params.set('exclude', excludeRepId);
        const res = await fetch(`/api/admin/sales-reps?${params.toString()}`);
        if (!res.ok) return;
        const body = (await res.json()) as { duplicate?: RepDuplicate };
        if (!cancelled) setDuplicate(body.duplicate ?? null);
      } catch {
        // Network hiccup — leave the warning off rather than block the form.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [email, excludeRepId]);

  return duplicate;
}
