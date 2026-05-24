import { db } from '@/lib/db';
import {
  getCustomerLedger,
  ledgerHref,
  parseLedgerDate,
  parseLedgerType,
  CUSTOMER_LEDGER_TYPES,
} from '@/server/services/entityLedger';
import {
  LEDGER_TYPE_META,
  type LedgerRegisterRow,
} from '@/components/ledger/ledger-register';
import { LedgerTabBody } from '@/components/ledger/ledger-tab-body';
import type { LedgerTypeOption } from '@/components/ledger/ledger-filters';

const PAGE_SIZE = 50;

const TYPE_OPTIONS: LedgerTypeOption[] = CUSTOMER_LEDGER_TYPES.map((t) => ({
  value: t,
  label: LEDGER_TYPE_META[t].label,
}));

type SP = Record<string, string | string[] | undefined>;

function readStr(sp: SP, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

function readSkip(sp: SP, key: string): number {
  const v = readStr(sp, key);
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function CustomerLedgerTab({
  customerId,
  customerName,
  searchParams = {},
}: {
  customerId: string;
  customerName: string;
  searchParams?: SP;
}) {
  const from = parseLedgerDate(readStr(searchParams, 'ledgerFrom'), false);
  const to = parseLedgerDate(readStr(searchParams, 'ledgerTo'), true);
  const type = parseLedgerType(readStr(searchParams, 'ledgerType'), CUSTOMER_LEDGER_TYPES);
  const sort = readStr(searchParams, 'ledgerSort') === 'oldest' ? 'oldest' : 'newest';
  const skip = readSkip(searchParams, 'ledgerSkip');

  const ledger = await getCustomerLedger(db, customerId, {
    from,
    to,
    type,
    sort,
    skip,
    take: PAGE_SIZE,
  });

  const rows: LedgerRegisterRow[] = ledger.rows.map((r) => {
    const meta = LEDGER_TYPE_META[r.type];
    return {
      id: r.id,
      date: r.date,
      typeLabel: meta.label,
      typeTone: meta.tone,
      number: r.number,
      description: r.description,
      href: ledgerHref(r.linkType, r.linkId),
      debit: r.debit.greaterThan(0) ? r.debit.toString() : null,
      credit: r.credit.greaterThan(0) ? r.credit.toString() : null,
      runningBalance: r.runningBalance.toString(),
    };
  });

  return (
    <LedgerTabBody
      basePath={`/customers/${customerId}`}
      exportBaseHref={`/api/customers/${customerId}/ledger/export`}
      typeOptions={TYPE_OPTIONS}
      rows={rows}
      total={ledger.total}
      skip={skip}
      take={PAGE_SIZE}
      currentBalance={ledger.currentBalance.toString()}
      windowDebits={ledger.windowDebits.toString()}
      windowCredits={ledger.windowCredits.toString()}
      positiveLabel={`Balance owed by ${customerName}`}
      negativeLabel="Credit / prepaid on hand"
    />
  );
}
