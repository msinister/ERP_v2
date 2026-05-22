import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction, Prisma } from '@/generated/tenant';
import type { GlAccount, JournalEntry, PrismaClient } from '@/generated/tenant';
import {
  postAccountTransfer,
  listAccountTransfersPaged,
  ACCOUNT_TRANSFER_ENTITY_TYPE,
} from '@/server/services/accountTransfers';
import { hasTenantDb, makeClient } from '../helpers/db';

const suite = hasTenantDb ? describe : describe.skip;

function assertBalanced(je: {
  lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): void {
  const dr = je.lines.reduce((a, l) => a.plus(l.debit), new Prisma.Decimal(0));
  const cr = je.lines.reduce((a, l) => a.plus(l.credit), new Prisma.Decimal(0));
  if (!dr.equals(cr)) {
    throw new Error(`JE not balanced: debits=${dr} credits=${cr}`);
  }
}

suite('Account Transfer', () => {
  let db: PrismaClient;
  let cash: GlAccount; // 1110 ASSET
  let creditCard: GlAccount; // 2030 LIABILITY (stand-in card payable)
  let expense: GlAccount; // 5500 EXPENSE (invalid for transfers)
  const created: string[] = [];

  async function cleanup(ids: string[]) {
    if (ids.length === 0) return;
    await db.journalEntryLine.deleteMany({
      where: { journalEntryId: { in: ids } },
    });
    await db.auditLog.deleteMany({
      where: { entityType: ACCOUNT_TRANSFER_ENTITY_TYPE, entityId: { in: ids } },
    });
    await db.journalEntry.deleteMany({ where: { id: { in: ids } } });
  }

  function track<T extends JournalEntry>(je: T): T {
    created.push(je.id);
    return je;
  }

  beforeAll(async () => {
    db = makeClient();
    cash = await db.glAccount.findFirstOrThrow({ where: { code: '1110' } });
    creditCard = await db.glAccount.findFirstOrThrow({
      where: { code: '2030' },
    });
    expense = await db.glAccount.findFirstOrThrow({ where: { code: '5500' } });
  });

  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('posts a balanced DR to / CR from JE tagged AccountTransfer, with reference + notes', async () => {
    const je = track(
      await postAccountTransfer(db, {
        fromAccountId: cash.id,
        toAccountId: creditCard.id,
        amount: '150.00',
        reference: 'CONF-12345',
        notes: 'May card payment',
      }),
    );

    expect(je.number).toMatch(/^JE-\d{4}-\d{5,}$/);
    expect(je.entityType).toBe(ACCOUNT_TRANSFER_ENTITY_TYPE);
    expect(je.description).toBe(`Transfer: ${cash.name} → ${creditCard.name}`);
    expect(je.reference).toBe('CONF-12345');
    expect(je.notes).toBe('May card payment');

    assertBalanced(je);
    const full = await db.journalEntry.findUniqueOrThrow({
      where: { id: je.id },
      include: { lines: { include: { account: true } } },
    });
    expect(full.lines).toHaveLength(2);
    const dr = full.lines.find((l) => l.debit.greaterThan(0));
    const cr = full.lines.find((l) => l.credit.greaterThan(0));
    // DR the destination (credit card), CR the source (cash).
    expect(dr?.account.code).toBe('2030');
    expect(dr?.debit.toString()).toBe(new Prisma.Decimal('150').toString());
    expect(cr?.account.code).toBe('1110');
    expect(cr?.credit.toString()).toBe(new Prisma.Decimal('150').toString());

    const audits = await db.auditLog.findMany({
      where: {
        entityType: ACCOUNT_TRANSFER_ENTITY_TYPE,
        entityId: je.id,
      },
    });
    expect(audits.find((a) => a.action === AuditAction.CREATE)).toBeDefined();
  });

  it('persists null reference + notes when omitted', async () => {
    const je = track(
      await postAccountTransfer(db, {
        fromAccountId: cash.id,
        toAccountId: creditCard.id,
        amount: '10',
      }),
    );
    expect(je.reference).toBeNull();
    expect(je.notes).toBeNull();
  });

  it('rejects identical from / to accounts', async () => {
    await expect(
      postAccountTransfer(db, {
        fromAccountId: cash.id,
        toAccountId: cash.id,
        amount: '10',
      }),
    ).rejects.toThrow(/must be different/i);
  });

  it('rejects an EXPENSE account as a transfer leg', async () => {
    await expect(
      postAccountTransfer(db, {
        fromAccountId: cash.id,
        toAccountId: expense.id,
        amount: '10',
      }),
    ).rejects.toThrow(/ASSET and LIABILITY/);
  });

  it('lists transfers with from / to derived from the legs', async () => {
    const je = track(
      await postAccountTransfer(db, {
        fromAccountId: cash.id,
        toAccountId: creditCard.id,
        amount: '77.50',
        reference: 'LIST-TEST',
      }),
    );

    const page = await listAccountTransfersPaged(db, {
      fromAccountId: cash.id,
      toAccountId: creditCard.id,
    });
    const row = page.rows.find((r) => r.id === je.id);
    expect(row).toBeDefined();
    expect(row?.fromCode).toBe('1110');
    expect(row?.toCode).toBe('2030');
    expect(row?.amount.toString()).toBe(new Prisma.Decimal('77.5').toString());
    expect(row?.reference).toBe('LIST-TEST');
  });
});
