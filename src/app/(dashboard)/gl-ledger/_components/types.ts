import type { AccountType } from '@/generated/tenant';

// Account option for the selector. `bucket` drives the Cash / Credit-card
// quick filters (code ranges 1100-1199 / 2100-2199, computed server-side).
export type SelectorAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  bucket: 'cash' | 'card' | 'other';
};
