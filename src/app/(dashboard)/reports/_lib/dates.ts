// Shared date utilities for the reports UI.
//
// Service convention: every period filter is half-open — `from` is
// inclusive (gte), `to` / `asOf` are exclusive (lt). To make the URL
// query params feel natural ("show me activity through 2026-05-13"),
// the page parses the user's `to` / `asOf` and shifts it forward one
// day before calling the service. So the form field always means
// "inclusive end date."

export function parseDateInput(s: string | undefined | null): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Treat the date-only string as UTC midnight. Avoids local-tz drift
  // that `new Date('2026-05-13')` already does correctly but `new
  // Date(2026, 4, 13)` would not.
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysUtc(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function yearStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

export function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// For the inclusive-end display ("through Apr 30") show `to − 1 day`
// because `to` is the exclusive upper bound.
export function formatInclusiveEnd(toExclusive: Date): string {
  return formatDateDisplay(addDaysUtc(toExclusive, -1));
}
