import { describe, expect, it } from 'vitest';
import { PaymentMethod, Prisma, RmaStatus } from '@/generated/tenant';
import {
  applyCreditInputSchema,
  confirmCreditMemoInputSchema,
  createCreditMemoInputSchema,
  createRmaInputSchema,
  recordPaymentInputSchema,
  reversePaymentInputSchema,
  transitionRmaInputSchema,
  voidCreditMemoInputSchema,
} from '@/lib/validation/invoicing';

// Pure-validation tests — no DB. Lives under tests/integration/ to
// match the existing invoicing-slice layout, but has no `hasTenantDb`
// guard since none is needed.

describe('validation/invoicing — recordPaymentInputSchema', () => {
  it('happy path', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '100',
      reference: 'check #1234',
    });
    expect(r.success).toBe(true);
  });

  it('amount=0 rejected (must be > 0)', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '0',
    });
    expect(r.success).toBe(false);
  });

  it('negative amount rejected', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '-5',
    });
    expect(r.success).toBe(false);
  });

  it('Decimal precision: 12.34567 round-trips without loss', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '12.34567',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe('12.34567');
  });

  it('overapplication rejected — sum of applications > amount', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [
        { invoiceId: 'inv1', amount: '60' },
        { invoiceId: 'inv2', amount: '50' },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.match(/exceeds payment amount/))).toBe(true);
    }
  });

  it('underapplication accepted — remainder becomes unapplied credit', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.CHECK,
      amount: '100',
      applications: [{ invoiceId: 'inv1', amount: '60' }],
    });
    expect(r.success).toBe(true);
  });

  it('APPLIED_CREDIT method without applications throws', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.APPLIED_CREDIT,
      amount: '50',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.match(/APPLIED_CREDIT requires/))).toBe(true);
    }
  });

  it('APPLIED_CREDIT with applications passes', () => {
    const r = recordPaymentInputSchema.safeParse({
      customerId: 'cust1',
      method: PaymentMethod.APPLIED_CREDIT,
      amount: '50',
      applications: [{ invoiceId: 'inv1', amount: '50' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('validation/invoicing — applyCreditInputSchema', () => {
  it('happy path with paymentId', () => {
    const r = applyCreditInputSchema.safeParse({
      paymentId: 'pmt1',
      invoiceId: 'inv1',
      amount: '50',
    });
    expect(r.success).toBe(true);
  });

  it('happy path with creditMemoId', () => {
    const r = applyCreditInputSchema.safeParse({
      creditMemoId: 'cm1',
      invoiceId: 'inv1',
      amount: '50',
    });
    expect(r.success).toBe(true);
  });

  it('both paymentId AND creditMemoId rejected (XOR violation)', () => {
    const r = applyCreditInputSchema.safeParse({
      paymentId: 'pmt1',
      creditMemoId: 'cm1',
      invoiceId: 'inv1',
      amount: '50',
    });
    expect(r.success).toBe(false);
  });

  it('neither paymentId nor creditMemoId rejected', () => {
    const r = applyCreditInputSchema.safeParse({
      invoiceId: 'inv1',
      amount: '50',
    });
    expect(r.success).toBe(false);
  });

  it('amount=0 rejected', () => {
    const r = applyCreditInputSchema.safeParse({
      paymentId: 'pmt1',
      invoiceId: 'inv1',
      amount: '0',
    });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — reversePaymentInputSchema', () => {
  it('happy path', () => {
    const r = reversePaymentInputSchema.safeParse({
      paymentId: 'pmt1',
      reason: 'check bounced',
    });
    expect(r.success).toBe(true);
  });

  it('missing reason rejected', () => {
    const r = reversePaymentInputSchema.safeParse({
      paymentId: 'pmt1',
    });
    expect(r.success).toBe(false);
  });

  it('empty reason rejected', () => {
    const r = reversePaymentInputSchema.safeParse({
      paymentId: 'pmt1',
      reason: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — createCreditMemoInputSchema', () => {
  it('happy path with invoiceId', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      categoryId: 'cat1',
      amount: '100',
      lines: [
        { variantId: 'v1', qty: '2', unitPrice: '50', description: 'returned widget' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('happy path without invoiceId (goodwill / bad-debt)', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      categoryId: 'cat-goodwill',
      amount: '50',
      lines: [
        { variantId: 'v1', qty: '1', unitPrice: '50', description: 'goodwill' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('empty lines rejected', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      categoryId: 'cat1',
      amount: '100',
      lines: [],
    });
    expect(r.success).toBe(false);
  });

  it('amount=0 rejected', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      categoryId: 'cat1',
      amount: '0',
      lines: [
        { variantId: 'v1', qty: '1', unitPrice: '50', description: 'x' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('line qty=0 rejected', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      categoryId: 'cat1',
      amount: '50',
      lines: [
        { variantId: 'v1', qty: '0', unitPrice: '50', description: 'x' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('negative restockingFee rejected', () => {
    const r = createCreditMemoInputSchema.safeParse({
      customerId: 'cust1',
      categoryId: 'cat1',
      amount: '50',
      restockingFee: '-1',
      lines: [
        { variantId: 'v1', qty: '1', unitPrice: '50', description: 'x' },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — confirmCreditMemoInputSchema', () => {
  it('happy path', () => {
    const r = confirmCreditMemoInputSchema.safeParse({ creditMemoId: 'cm1' });
    expect(r.success).toBe(true);
  });

  it('missing creditMemoId rejected', () => {
    const r = confirmCreditMemoInputSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — voidCreditMemoInputSchema', () => {
  it('happy path', () => {
    const r = voidCreditMemoInputSchema.safeParse({
      creditMemoId: 'cm1',
      reason: 'duplicate',
    });
    expect(r.success).toBe(true);
  });

  it('missing reason rejected', () => {
    const r = voidCreditMemoInputSchema.safeParse({ creditMemoId: 'cm1' });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — createRmaInputSchema', () => {
  it('happy path', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      lines: [{ invoiceLineId: 'il1', qty: '2' }],
    });
    expect(r.success).toBe(true);
  });

  it('returnless flag accepted', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      returnless: true,
      lines: [{ invoiceLineId: 'il1', qty: '1' }],
    });
    expect(r.success).toBe(true);
  });

  it('both restockingFeePercent AND restockingFeeFlat rejected', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      restockingFeePercent: '10',
      restockingFeeFlat: '5',
      lines: [{ invoiceLineId: 'il1', qty: '1' }],
    });
    expect(r.success).toBe(false);
  });

  it('restockingFeePercent > 100 rejected', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      restockingFeePercent: '101',
      lines: [{ invoiceLineId: 'il1', qty: '1' }],
    });
    expect(r.success).toBe(false);
  });

  it('empty lines rejected', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      lines: [],
    });
    expect(r.success).toBe(false);
  });

  it('line qty=0 rejected', () => {
    const r = createRmaInputSchema.safeParse({
      customerId: 'cust1',
      invoiceId: 'inv1',
      lines: [{ invoiceLineId: 'il1', qty: '0' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — transitionRmaInputSchema', () => {
  it('to=APPROVED without reason succeeds', () => {
    const r = transitionRmaInputSchema.safeParse({
      rmaId: 'rma1',
      to: RmaStatus.APPROVED,
    });
    expect(r.success).toBe(true);
  });

  it('to=REJECTED without reason throws', () => {
    const r = transitionRmaInputSchema.safeParse({
      rmaId: 'rma1',
      to: RmaStatus.REJECTED,
    });
    expect(r.success).toBe(false);
  });

  it('to=REJECTED with empty reason throws', () => {
    const r = transitionRmaInputSchema.safeParse({
      rmaId: 'rma1',
      to: RmaStatus.REJECTED,
      reason: '   ',
    });
    expect(r.success).toBe(false);
  });

  it('to=REJECTED with reason succeeds', () => {
    const r = transitionRmaInputSchema.safeParse({
      rmaId: 'rma1',
      to: RmaStatus.REJECTED,
      reason: 'duplicate request',
    });
    expect(r.success).toBe(true);
  });

  it('unknown status rejected', () => {
    const r = transitionRmaInputSchema.safeParse({
      rmaId: 'rma1',
      to: 'NOT_A_STATUS' as never,
    });
    expect(r.success).toBe(false);
  });
});

describe('validation/invoicing — Decimal precision across all schemas', () => {
  it('amount strings round-trip exactly without floating-point loss', () => {
    const cases = ['12.34567', '0.00001', '999999.99999'];
    for (const amount of cases) {
      const r = recordPaymentInputSchema.safeParse({
        customerId: 'cust1',
        method: PaymentMethod.CHECK,
        amount,
      });
      expect(r.success, `parsing ${amount}`).toBe(true);
      if (r.success) {
        // Verify the amount is preserved exactly when re-converted.
        expect(new Prisma.Decimal(r.data.amount).toString()).toBe(
          new Prisma.Decimal(amount).toString(),
        );
      }
    }
  });
});
