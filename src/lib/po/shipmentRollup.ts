// Roll a PO's shipment statuses up to a single header badge value, per the
// PO shipment-tracking spec precedence:
//
//   no shipments                                  -> null (render nothing)
//   any IN_TRANSIT                                -> IN_TRANSIT
//   all DELIVERED                                 -> DELIVERED
//   any IN_PRODUCTION (and none in transit)       -> IN_PRODUCTION
//   any PAID (and nothing further)               -> PAID
//
// Statuses are plain strings (the PoShipmentStatus enum values) so this
// helper can be reused by both the server page and list table without
// pulling the generated enum into client bundles.
export function rollupShipmentStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  if (statuses.some((s) => s === 'IN_TRANSIT')) return 'IN_TRANSIT';
  if (statuses.every((s) => s === 'DELIVERED')) return 'DELIVERED';
  if (statuses.some((s) => s === 'IN_PRODUCTION')) return 'IN_PRODUCTION';
  if (statuses.some((s) => s === 'PAID')) return 'PAID';
  // Mixed terminal set with no PAID/PRODUCTION/TRANSIT (e.g. some DELIVERED
  // among non-standard values) — fall back to the most-advanced present.
  if (statuses.some((s) => s === 'DELIVERED')) return 'DELIVERED';
  return null;
}
