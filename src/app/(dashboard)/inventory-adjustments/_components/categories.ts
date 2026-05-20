// Shared display labels for the AdjustmentCategory enum.
export const CATEGORY_LABELS: Record<string, string> = {
  SHORTAGE: 'Shortage',
  BREAKAGE: 'Breakage',
  MISSING: 'Missing',
  THEFT: 'Theft',
  DEFECT: 'Defect',
  REJECT: 'Reject',
  FOUND_STOCK: 'Found stock',
  CYCLE_COUNT: 'Cycle count',
  OTHER: 'Other',
};

export const CATEGORY_OPTIONS: Array<{ value: string; label: string }> =
  Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));

export function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value] ?? value;
}
