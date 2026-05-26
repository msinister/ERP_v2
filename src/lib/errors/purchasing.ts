// Typed error for the "can't cancel a PO that still has active receipts"
// case. Mirrors SalesOrderCancelBlockedError (lib/errors/credit.ts): the
// service throws it, the cancel route serializes { error, code, receipts },
// and the PO cancel dialog renders the blocking receipts as links so the
// operator can reverse them. Active = receipt lines not soft-deleted, i.e.
// POSTED receipts (cancelling a receipt soft-deletes its lines).

export class PurchaseOrderCancelBlockedError extends Error {
  readonly code = 'PO_CANCEL_BLOCKED_BY_RECEIPTS';
  readonly purchaseOrderId: string;
  readonly receipts: Array<{ id: string; number: string }>;

  constructor(args: {
    purchaseOrderId: string;
    receipts: Array<{ id: string; number: string }>;
  }) {
    const list = args.receipts.map((r) => r.number).join(', ');
    super(
      `Cannot cancel purchase order: reverse its receipt(s) first` +
        (list ? ` (${list})` : '') +
        '.',
    );
    this.name = 'PurchaseOrderCancelBlockedError';
    this.purchaseOrderId = args.purchaseOrderId;
    this.receipts = args.receipts;
  }
}
