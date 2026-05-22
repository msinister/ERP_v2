import { describe, expect, it } from 'vitest';
import { Prisma, SalesOrderStatus } from '@/generated/tenant';
import {
  effectiveBillableQty,
  computeLineBillableTotal,
} from '@/lib/sales/lineTotals';

const D = (v: string | number) => new Prisma.Decimal(v);

function line(overrides: Partial<{
  qtyOrdered: string;
  qtyShipped: string;
  unitPrice: string;
  discountPercent: string | null;
  discountAmount: string | null;
}> = {}) {
  return {
    qtyOrdered: D(overrides.qtyOrdered ?? '1000'),
    qtyShipped: D(overrides.qtyShipped ?? '0'),
    unitPrice: D(overrides.unitPrice ?? '0.93'),
    discountPercent:
      overrides.discountPercent != null ? D(overrides.discountPercent) : null,
    discountAmount:
      overrides.discountAmount != null ? D(overrides.discountAmount) : null,
  };
}

describe('effectiveBillableQty', () => {
  it('DRAFT always uses qtyOrdered', () => {
    const l = line({ qtyOrdered: '1000', qtyShipped: '10000' });
    expect(effectiveBillableQty(l, SalesOrderStatus.DRAFT).toString()).toBe('1000');
  });

  it('CONFIRMED / DISPATCHED use qtyShipped only when > 0', () => {
    const noShip = line({ qtyOrdered: '1000', qtyShipped: '0' });
    const shipped = line({ qtyOrdered: '1000', qtyShipped: '10000' });
    for (const s of [SalesOrderStatus.CONFIRMED, SalesOrderStatus.DISPATCHED]) {
      expect(effectiveBillableQty(noShip, s).toString()).toBe('1000');
      expect(effectiveBillableQty(shipped, s).toString()).toBe('10000');
    }
  });

  it('CLOSED always uses qtyShipped (even when 0)', () => {
    expect(
      effectiveBillableQty(line({ qtyShipped: '7' }), SalesOrderStatus.CLOSED).toString(),
    ).toBe('7');
    expect(
      effectiveBillableQty(line({ qtyShipped: '0' }), SalesOrderStatus.CLOSED).toString(),
    ).toBe('0');
  });

  it('CANCELLED falls back to qtyOrdered', () => {
    expect(
      effectiveBillableQty(
        line({ qtyOrdered: '5', qtyShipped: '9' }),
        SalesOrderStatus.CANCELLED,
      ).toString(),
    ).toBe('5');
  });
});

describe('computeLineBillableTotal', () => {
  it('the bug case: 10000 shipped × $0.93 = $9,300 once shipped on a CONFIRMED order', () => {
    const l = line({ qtyOrdered: '1000', qtyShipped: '10000', unitPrice: '0.93' });
    // Pre-ship (commitment): 1000 × 0.93 = 930.
    expect(
      computeLineBillableTotal(line({ qtyShipped: '0' }), SalesOrderStatus.CONFIRMED).toString(),
    ).toBe(D('930').toString());
    // After shipped qty entered: 10000 × 0.93 = 9300.
    expect(
      computeLineBillableTotal(l, SalesOrderStatus.CONFIRMED).toString(),
    ).toBe(D('9300').toString());
  });

  it('applies a percent discount on the billable qty', () => {
    const l = line({ qtyShipped: '100', unitPrice: '10', discountPercent: '10' });
    // CLOSED → 100 × 10 = 1000, less 10% = 900.
    expect(computeLineBillableTotal(l, SalesOrderStatus.CLOSED).toString()).toBe(
      D('900').toString(),
    );
  });

  it('applies a flat discount and clamps to zero', () => {
    const l = line({ qtyShipped: '2', unitPrice: '10', discountAmount: '5' });
    expect(computeLineBillableTotal(l, SalesOrderStatus.CLOSED).toString()).toBe(
      D('15').toString(),
    );
    const big = line({ qtyShipped: '1', unitPrice: '10', discountAmount: '999' });
    expect(computeLineBillableTotal(big, SalesOrderStatus.CLOSED).toString()).toBe(
      '0',
    );
  });
});
