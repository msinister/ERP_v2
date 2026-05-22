// Shared option shapes for the expense entry forms.

export type AccountOption = { id: string; code: string; name: string };

// Expense GL account + how often it's been used as an expense category,
// so the dropdown can float the most-used ones to the top.
export type CategoryOption = {
  id: string;
  code: string;
  name: string;
  uses: number;
};

// localStorage key for the operator's last-used payment account — shared
// by the single-entry and bulk-paste forms so it persists across both.
export const LAST_PAYMENT_ACCOUNT_KEY = 'erp:expense:lastPaymentAccount';
