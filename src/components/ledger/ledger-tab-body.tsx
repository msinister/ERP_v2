import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  LedgerRegister,
  type LedgerRegisterRow,
} from './ledger-register';
import { LedgerFilters, type LedgerTypeOption } from './ledger-filters';
import { LedgerPager } from './ledger-pager';

// Shared body for the vendor + customer Ledger tabs. The owning tab fetches
// the ledger, maps service rows → register rows, and passes display config.

export function LedgerTabBody({
  basePath,
  exportBaseHref,
  typeOptions,
  rows,
  total,
  skip,
  take,
  currentBalance,
  windowDebits,
  windowCredits,
  positiveLabel,
  negativeLabel,
}: {
  basePath: string;
  exportBaseHref: string;
  typeOptions: LedgerTypeOption[];
  rows: LedgerRegisterRow[];
  total: number;
  skip: number;
  take: number;
  // Decimal strings.
  currentBalance: string;
  windowDebits: string;
  windowCredits: string;
  // Headline label depending on the balance sign.
  positiveLabel: string; // balance >= 0 (owed)
  negativeLabel: string; // balance < 0 (credit / prepaid)
}) {
  const isCredit = currentBalance.startsWith('-');
  const magnitude = isCredit ? currentBalance.slice(1) : currentBalance;

  return (
    <div className="space-y-4 pt-4">
      <Card size="sm">
        <CardContent className="flex flex-wrap items-end justify-between gap-4 py-5">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {isCredit ? negativeLabel : positiveLabel}
            </div>
            <div
              className={cn(
                'text-3xl font-semibold tabular-nums',
                isCredit ? 'text-emerald-600 dark:text-emerald-500' : 'text-foreground',
              )}
            >
              {formatCurrency(magnitude)}
            </div>
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            Running balance is net: charges (bills/invoices) add, payments,
            credits and deposits subtract. A negative balance means a credit
            or prepayment is on hand.
          </p>
        </CardContent>
      </Card>

      <LedgerFilters
        basePath={basePath}
        exportBaseHref={exportBaseHref}
        typeOptions={typeOptions}
      />

      <LedgerRegister
        rows={rows}
        windowDebits={windowDebits}
        windowCredits={windowCredits}
        currentBalance={currentBalance}
      />

      <LedgerPager basePath={basePath} total={total} skip={skip} take={take} />
    </div>
  );
}
