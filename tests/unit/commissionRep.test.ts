import { describe, expect, it } from 'vitest';
import { pickEffectiveCommissionRep } from '@/server/services/commission';

// Commission must follow the EFFECTIVE rep: a per-order override wins over
// the customer's default. This is the financial half of the "change rep on
// an SO" feature — a reassigned order's commission goes to the new rep.

const overrideRep = { id: 'rep-override' };
const customerRep = { id: 'rep-customer-default' };

describe('pickEffectiveCommissionRep', () => {
  it('uses the per-order override when SalesOrder.salesRepId is set', () => {
    expect(
      pickEffectiveCommissionRep({
        salesRepId: 'rep-override',
        salesRep: overrideRep,
        customer: { salesRep: customerRep },
      }),
    ).toBe(overrideRep);
  });

  it('falls back to the customer default when there is no override', () => {
    expect(
      pickEffectiveCommissionRep({
        salesRepId: null,
        salesRep: null,
        customer: { salesRep: customerRep },
      }),
    ).toBe(customerRep);
  });

  it('returns null when there is no sales order', () => {
    expect(pickEffectiveCommissionRep(null)).toBeNull();
    expect(pickEffectiveCommissionRep(undefined)).toBeNull();
  });

  it('returns null when neither override nor customer rep exists', () => {
    expect(
      pickEffectiveCommissionRep({
        salesRepId: null,
        salesRep: null,
        customer: { salesRep: null },
      }),
    ).toBeNull();
  });
});
