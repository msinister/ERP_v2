import { AccountType } from '@/generated/tenant';
import { db } from '@/lib/db';
import { requirePagePermission } from '@/lib/permissions/requirePagePermission';
import { listAccounts } from '@/server/services/glAccounts';
import { listAccountTransfersPaged } from '@/server/services/accountTransfers';
import { BillsPagination } from '../bills/_components/pagination';
import { TransferForm } from './_components/transfer-form';
import { TransferFilters } from './_components/transfer-filters';
import {
  TransferTable,
  type TransferRowData,
} from './_components/transfer-table';
import type { TransferAccountOption } from './_components/types';

export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 20;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

function parseDateInput(
  v: string | undefined,
  endOfDay: boolean,
): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePagePermission('gl.view');
  const sp = await searchParams;
  const fromAccountId = pickString(sp.fromAccountId);
  const toAccountId = pickString(sp.toAccountId);
  const dateFrom = parseDateInput(pickString(sp.dateFrom), false);
  const dateTo = parseDateInput(pickString(sp.dateTo), true);
  const skip = Math.max(0, Number(pickString(sp.skip) ?? '0') || 0);
  const take = DEFAULT_PAGE_SIZE;

  const [allAccounts, page] = await Promise.all([
    listAccounts(db, { active: true, take: 500 }),
    listAccountTransfersPaged(db, {
      fromAccountId,
      toAccountId,
      from: dateFrom,
      to: dateTo,
      skip,
      take,
    }),
  ]);

  // Transfer-eligible accounts: cash/bank (ASSET) + credit-card payable /
  // lines of credit (LIABILITY). Sorted by code so presets are stable.
  const accounts: TransferAccountOption[] = allAccounts
    .filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
    )
    .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }));

  const rows: TransferRowData[] = page.rows.map((r) => ({
    id: r.id,
    number: r.number,
    postedAt: r.postedAt,
    fromCode: r.fromCode,
    fromName: r.fromName,
    toCode: r.toCode,
    toName: r.toName,
    amount: r.amount.toString(),
    reference: r.reference,
    notes: r.notes,
    reversedAt: r.reversedAt,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Transfers</h1>
        <p className="text-sm text-muted-foreground">
          Move money between accounts — pay a credit card from the bank,
          shift between bank accounts, etc. Each transfer posts a balanced
          journal entry.
        </p>
      </div>

      <TransferForm accounts={accounts} />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Transfer history
        </h2>
        <TransferFilters accounts={accounts} />
        <TransferTable rows={rows} />
        <BillsPagination
          total={page.total}
          skip={skip}
          take={take}
          basePath="/transfers"
        />
      </div>
    </div>
  );
}
