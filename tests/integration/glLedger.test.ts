import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountType, Prisma } from '@/generated/tenant';
import type { GlAccount, PrismaClient } from '@/generated/tenant';
import { postAccountTransfer } from '@/server/services/accountTransfers';
import {
  getAccountLedger,
  naturalBalance,
} from '@/server/services/glLedger';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;
const ASSET_CODE = 'TST-LEDGER-A';
const LIAB_CODE = 'TST-LEDGER-L';

function d(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

suite('GL Ledger', () => {
  let db: PrismaClient;
  let asset: GlAccount; // dedicated test ASSET (isolated activity)
  let liability: GlAccount; // dedicated test LIABILITY

  async function wipe() {
    const ids = [asset?.id, liability?.id].filter(Boolean) as string[];
    if (ids.length === 0) return;
    const jeLines = await db.journalEntryLine.findMany({
      where: { accountId: { in: ids } },
      select: { journalEntryId: true },
    });
    const jeIds = Array.from(new Set(jeLines.map((l) => l.journalEntryId)));
    if (jeIds.length > 0) {
      await db.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      });
      await db.auditLog.deleteMany({
        where: { entityType: 'AccountTransfer', entityId: { in: jeIds } },
      });
      await db.journalEntry.deleteMany({ where: { id: { in: jeIds } } });
    }
  }

  beforeAll(async () => {
    db = makeClient();
    asset = await db.glAccount.upsert({
      where: { code: ASSET_CODE },
      create: { code: ASSET_CODE, name: 'Test Ledger Cash', type: AccountType.ASSET },
      update: { deletedAt: null, active: true, type: AccountType.ASSET },
    });
    liability = await db.glAccount.upsert({
      where: { code: LIAB_CODE },
      create: { code: LIAB_CODE, name: 'Test Ledger Card', type: AccountType.LIABILITY },
      update: { deletedAt: null, active: true, type: AccountType.LIABILITY },
    });
    await wipe();

    // T1 Jan: DR asset 100 / CR liab 100  (from liab → asset)
    await postAccountTransfer(db, {
      fromAccountId: liability.id,
      toAccountId: asset.id,
      amount: '100',
      date: d('2026-01-01'),
      reference: 'T1',
    });
    // T2 Feb: DR liab 30 / CR asset 30   (from asset → liab)
    await postAccountTransfer(db, {
      fromAccountId: asset.id,
      toAccountId: liability.id,
      amount: '30',
      date: d('2026-02-01'),
      reference: 'T2',
    });
    // T3 Mar: DR asset 50 / CR liab 50   (from liab → asset)
    await postAccountTransfer(db, {
      fromAccountId: liability.id,
      toAccountId: asset.id,
      amount: '50',
      date: d('2026-03-01'),
      reference: 'T3',
    });
  });

  afterAll(async () => {
    await wipe();
    await db.glAccount.deleteMany({
      where: { code: { in: [ASSET_CODE, LIAB_CODE] } },
    });
    await db.$disconnect();
  });

  it('lists newest-first with correct chronological running balances', async () => {
    const ledger = await getAccountLedger(db, { accountId: asset.id });
    expect(ledger).not.toBeNull();
    expect(ledger!.total).toBe(3);

    // All-time signed balance: +100 − 30 + 50 = 120 (debit-normal asset).
    expect(ledger!.currentSignedBalance.toString()).toBe(
      new Prisma.Decimal('120').toString(),
    );

    const [r0, r1, r2] = ledger!.rows;
    // Newest first: T3, T2, T1.
    expect(r0.reference).toBe('T3');
    expect(r0.debit.toString()).toBe(new Prisma.Decimal('50').toString());
    expect(r0.signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('120').toString(),
    );
    expect(r1.reference).toBe('T2');
    expect(r1.credit.toString()).toBe(new Prisma.Decimal('30').toString());
    expect(r1.signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('70').toString(),
    );
    expect(r2.reference).toBe('T1');
    expect(r2.debit.toString()).toBe(new Prisma.Decimal('100').toString());
    expect(r2.signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('100').toString(),
    );

    // AccountTransfer rows deep-link via the JE id.
    expect(r0.entityType).toBe('AccountTransfer');
    expect(r0.linkId).toBe(r0.jeId);
  });

  it('carries a beginning balance into a date-filtered window', async () => {
    const ledger = await getAccountLedger(db, {
      accountId: asset.id,
      from: d('2026-02-01'),
    });
    // Window excludes T1; only T2 + T3 show, but the running balance still
    // reflects T1's +100 beginning balance.
    expect(ledger!.total).toBe(2);
    const [r0, r1] = ledger!.rows;
    expect(r0.reference).toBe('T3');
    expect(r0.signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('120').toString(),
    );
    expect(r1.reference).toBe('T2');
    // 100 (beginning) − 30 = 70.
    expect(r1.signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('70').toString(),
    );
  });

  it('paginates while keeping running balances correct', async () => {
    const page = await getAccountLedger(db, {
      accountId: asset.id,
      skip: 1,
      take: 1,
    });
    expect(page!.total).toBe(3);
    expect(page!.rows).toHaveLength(1);
    // Second row overall (skip 1) is T2.
    expect(page!.rows[0].reference).toBe('T2');
    expect(page!.rows[0].signedRunningBalance.toString()).toBe(
      new Prisma.Decimal('70').toString(),
    );
  });

  it('reports the liability balance as a positive "owed" amount (natural)', async () => {
    const ledger = await getAccountLedger(db, { accountId: liability.id });
    // Signed: −100 + 30 − 50 = −120. Natural (credit-normal) = +120 owed.
    expect(ledger!.currentSignedBalance.toString()).toBe(
      new Prisma.Decimal('-120').toString(),
    );
    const owed = naturalBalance(
      ledger!.currentSignedBalance,
      ledger!.account.type,
    );
    expect(owed.toString()).toBe(new Prisma.Decimal('120').toString());
  });
});
