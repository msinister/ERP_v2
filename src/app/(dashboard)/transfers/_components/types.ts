import type { AccountType } from '@/generated/tenant';

// Transfer-eligible GL account (ASSET or LIABILITY). `type` lets the
// entry form build the quick-select presets (first bank, first card, etc.).
export type TransferAccountOption = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
};
