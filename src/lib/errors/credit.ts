// Structured errors for credit-limit + AR-hold enforcement at SO
// confirm. Manager-override path waits for RBAC (Module 01); for
// pilot these always block. Carrying numeric context on the error
// instance lets the GUI render an actionable "X over limit" banner
// without re-querying.

export class CreditLimitExceededError extends Error {
  readonly code = 'CREDIT_LIMIT_EXCEEDED';
  readonly customerId: string;
  readonly creditLimit: string; // Decimal as string — never JS Number
  readonly arBalance: string;
  readonly openSosTotal: string;
  readonly thisOrderTotal: string;
  readonly projectedExposure: string;

  constructor(args: {
    customerId: string;
    creditLimit: string;
    arBalance: string;
    openSosTotal: string;
    thisOrderTotal: string;
    projectedExposure: string;
  }) {
    super(
      `Credit limit exceeded for customer ${args.customerId}: ` +
        `projected exposure ${args.projectedExposure} > limit ${args.creditLimit} ` +
        `(AR ${args.arBalance} + open SOs ${args.openSosTotal} + this order ${args.thisOrderTotal})`,
    );
    this.name = 'CreditLimitExceededError';
    this.customerId = args.customerId;
    this.creditLimit = args.creditLimit;
    this.arBalance = args.arBalance;
    this.openSosTotal = args.openSosTotal;
    this.thisOrderTotal = args.thisOrderTotal;
    this.projectedExposure = args.projectedExposure;
  }
}

export class SalesOrderCancelBlockedError extends Error {
  readonly code = 'SO_CANCEL_BLOCKED_BY_PAYMENT';
  readonly salesOrderId: string;
  readonly reason: 'PAYMENT_PRESENT';
  readonly paymentNumbers: string[];

  constructor(args: { salesOrderId: string; paymentNumbers: string[] }) {
    super(
      `Cannot cancel SalesOrder ${args.salesOrderId}: payment(s) attached ` +
        `(${args.paymentNumbers.join(', ')}). Reverse payment(s) first, then cancel.`,
    );
    this.name = 'SalesOrderCancelBlockedError';
    this.salesOrderId = args.salesOrderId;
    this.reason = 'PAYMENT_PRESENT';
    this.paymentNumbers = args.paymentNumbers;
  }
}

export class ArHoldExceededError extends Error {
  readonly code = 'AR_HOLD_EXCEEDED';
  readonly customerId: string;
  readonly arHoldDays: number;
  readonly worstInvoiceNumber: string;
  readonly worstInvoiceDaysPastDue: number;

  constructor(args: {
    customerId: string;
    arHoldDays: number;
    worstInvoiceNumber: string;
    worstInvoiceDaysPastDue: number;
  }) {
    super(
      `AR hold for customer ${args.customerId}: invoice ${args.worstInvoiceNumber} ` +
        `is ${args.worstInvoiceDaysPastDue} days past due ` +
        `(threshold ${args.arHoldDays} days)`,
    );
    this.name = 'ArHoldExceededError';
    this.customerId = args.customerId;
    this.arHoldDays = args.arHoldDays;
    this.worstInvoiceNumber = args.worstInvoiceNumber;
    this.worstInvoiceDaysPastDue = args.worstInvoiceDaysPastDue;
  }
}
