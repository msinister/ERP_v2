// Pure column-order helpers for table-view preferences. No React / client
// deps so they're trivially unit-testable and reusable. Used by
// useTablePreferences; kept separate from the hook for testability.

export type OrderColumn = { id: string; locked?: boolean };

// Reconcile a saved order against the page's current column set:
//   locked columns first (definition order, always pinned),
//   then saved order (entries that still exist + aren't locked),
//   then any columns missing from the saved order (new since it was saved),
//   in definition order. Robust to added/removed columns.
export function resolveOrder(
  columns: OrderColumn[],
  savedOrder: string[],
): string[] {
  const known = new Set(columns.map((c) => c.id));
  const lockedIds = columns.filter((c) => c.locked).map((c) => c.id);
  const lockedSet = new Set(lockedIds);
  const fromSaved = savedOrder.filter((id) => known.has(id) && !lockedSet.has(id));
  const placed = new Set([...lockedIds, ...fromSaved]);
  const rest = columns.map((c) => c.id).filter((id) => !placed.has(id));
  return [...lockedIds, ...fromSaved, ...rest];
}

// Move `activeId` to just before `overId` within the resolved order, then
// re-pin locked columns to the front. Returns the new full order, or null
// for a no-op (same id, locked active, or unknown ids).
export function reorderColumnIds(
  columns: OrderColumn[],
  currentOrder: string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const lockedSet = new Set(columns.filter((c) => c.locked).map((c) => c.id));
  if (lockedSet.has(activeId)) return null;
  const current = resolveOrder(columns, currentOrder);
  if (!current.includes(activeId) || !current.includes(overId)) return null;
  const without = current.filter((id) => id !== activeId);
  without.splice(without.indexOf(overId), 0, activeId);
  return [
    ...without.filter((id) => lockedSet.has(id)),
    ...without.filter((id) => !lockedSet.has(id)),
  ];
}
