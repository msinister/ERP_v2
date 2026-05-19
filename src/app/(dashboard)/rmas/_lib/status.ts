// Friendly display labels for RmaStatus values. The enum stores
// PENDING (etc) but operators see "Pending Review" everywhere.

const RMA_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending Review',
  APPROVED: 'Approved',
  IN_TRANSIT: 'In Transit',
  RECEIVED: 'Received',
  INSPECTED: 'Inspected',
  CREDITED: 'Credited',
  REJECTED: 'Rejected',
};

export function formatRmaStatusLabel(status: string): string {
  return RMA_STATUS_LABELS[status] ?? status;
}
