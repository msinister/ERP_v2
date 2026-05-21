import { describe, expect, it } from 'vitest';
import {
  countGranted,
  isPermissionKey,
  sanitizePermissionMap,
} from '@/lib/permissions/constants';
import { hasPermission, type Actor } from '@/lib/permissions/actor';
import {
  creditMemoScopeWhere,
  customerScopeWhere,
  dashboardScopeSalesRepId,
  paymentScopeWhere,
  resolveScope,
  rmaScopeWhere,
  salesOrderScopeWhere,
} from '@/lib/permissions/scope';

// Security-critical authorization logic. These pin the decisions the whole
// RBAC + data-scoping feature rests on: Super Admin bypass, grant lookup,
// and the all/own/none scope translation per entity.

const MATCH_NONE = '__no_access__';

function actor(partial: Partial<Actor>): Actor {
  return {
    id: 'u1',
    isSuperAdmin: false,
    salesRepId: null,
    permissions: {},
    ...partial,
  };
}

describe('sanitizePermissionMap', () => {
  it('keeps known keys set to true', () => {
    const out = sanitizePermissionMap({
      'customers.view_all': true,
      'sales_orders.create': true,
    });
    expect(out).toEqual({
      'customers.view_all': true,
      'sales_orders.create': true,
    });
  });

  it('drops false values and unknown keys', () => {
    const out = sanitizePermissionMap({
      'customers.view_all': false,
      'totally.bogus': true,
      'customers.edit': true,
    });
    expect(out).toEqual({ 'customers.edit': true });
  });

  it('returns {} for non-object input', () => {
    expect(sanitizePermissionMap(null)).toEqual({});
    expect(sanitizePermissionMap('nope')).toEqual({});
    expect(sanitizePermissionMap(42)).toEqual({});
  });
});

describe('countGranted + isPermissionKey', () => {
  it('counts only granted keys', () => {
    expect(countGranted({ 'customers.edit': true, 'customers.create': true })).toBe(2);
    expect(countGranted({})).toBe(0);
  });

  it('recognizes catalog keys only', () => {
    expect(isPermissionKey('customers.view_own')).toBe(true);
    expect(isPermissionKey('customers.telepathy')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('super admin holds everything', () => {
    const a = actor({ isSuperAdmin: true });
    expect(hasPermission(a, 'gl.close_period')).toBe(true);
    expect(hasPermission(a, 'admin.edit_roles')).toBe(true);
  });

  it('non-super holds only granted keys', () => {
    const a = actor({ permissions: { 'customers.view_own': true } });
    expect(hasPermission(a, 'customers.view_own')).toBe(true);
    expect(hasPermission(a, 'customers.view_all')).toBe(false);
  });
});

describe('sales_orders.change_rep', () => {
  it('is a recognized catalog key', () => {
    expect(isPermissionKey('sales_orders.change_rep')).toBe(true);
  });

  it('Super Admin can change rep without an explicit grant', () => {
    expect(
      hasPermission(actor({ isSuperAdmin: true }), 'sales_orders.change_rep'),
    ).toBe(true);
  });

  it('a "view own" rep without the grant cannot change rep', () => {
    const selfRep = actor({
      permissions: { 'sales_orders.view_own': true },
      salesRepId: 'rep-1',
    });
    expect(hasPermission(selfRep, 'sales_orders.change_rep')).toBe(false);
  });

  it('grants when the role includes it', () => {
    expect(
      hasPermission(
        actor({ permissions: { 'sales_orders.change_rep': true } }),
        'sales_orders.change_rep',
      ),
    ).toBe(true);
  });
});

describe('resolveScope', () => {
  const allKey = 'customers.view_all';
  const ownKey = 'customers.view_own';

  it('super admin → all', () => {
    expect(resolveScope(actor({ isSuperAdmin: true }), allKey, ownKey)).toBe('all');
  });

  it('view_all → all (overrides view_own)', () => {
    const a = actor({ permissions: { [allKey]: true, [ownKey]: true } });
    expect(resolveScope(a, allKey, ownKey)).toBe('all');
  });

  it('view_own only → own', () => {
    expect(resolveScope(actor({ permissions: { [ownKey]: true } }), allKey, ownKey)).toBe('own');
  });

  it('neither → none', () => {
    expect(resolveScope(actor({}), allKey, ownKey)).toBe('none');
  });
});

describe('customerScopeWhere', () => {
  it('all access → no restriction', () => {
    expect(customerScopeWhere(actor({ isSuperAdmin: true }))).toEqual({});
    expect(
      customerScopeWhere(actor({ permissions: { 'customers.view_all': true } })),
    ).toEqual({});
  });

  it('view_own with a linked rep → filter by salesRepId', () => {
    const a = actor({
      permissions: { 'customers.view_own': true },
      salesRepId: 'rep-7',
    });
    expect(customerScopeWhere(a)).toEqual({ salesRepId: 'rep-7' });
  });

  it('view_own with no linked rep → matches nothing', () => {
    const a = actor({ permissions: { 'customers.view_own': true } });
    expect(customerScopeWhere(a)).toEqual({ id: MATCH_NONE });
  });

  it('no view permission → matches nothing', () => {
    expect(customerScopeWhere(actor({}))).toEqual({ id: MATCH_NONE });
  });
});

describe('salesOrderScopeWhere', () => {
  it('all access → no restriction', () => {
    expect(
      salesOrderScopeWhere(actor({ permissions: { 'sales_orders.view_all': true } })),
    ).toEqual({});
  });

  it('view_own with a linked rep → matches override OR inherited rep', () => {
    const a = actor({
      permissions: { 'sales_orders.view_own': true },
      salesRepId: 'rep-7',
    });
    expect(salesOrderScopeWhere(a)).toEqual({
      OR: [
        { salesRepId: 'rep-7' },
        { salesRepId: null, customer: { salesRepId: 'rep-7' } },
      ],
    });
  });

  it('view_own with no linked rep → matches nothing', () => {
    const a = actor({ permissions: { 'sales_orders.view_own': true } });
    expect(salesOrderScopeWhere(a)).toEqual({ id: MATCH_NONE });
  });

  it('no view permission → matches nothing', () => {
    expect(salesOrderScopeWhere(actor({}))).toEqual({ id: MATCH_NONE });
  });
});

// The customer-relation scopers (Credit Memo, RMA, Payment) all resolve
// through customer.salesRepId — identical shape, one block each (literal
// keys keep the PermissionMap types happy).
describe('creditMemoScopeWhere', () => {
  it('all access → no restriction', () => {
    expect(creditMemoScopeWhere(actor({ isSuperAdmin: true }))).toEqual({});
    expect(
      creditMemoScopeWhere(actor({ permissions: { 'credit_memos.view_all': true } })),
    ).toEqual({});
  });
  it('view_own + linked rep → customer relation filter', () => {
    expect(
      creditMemoScopeWhere(
        actor({ permissions: { 'credit_memos.view_own': true }, salesRepId: 'rep-9' }),
      ),
    ).toEqual({ customer: { salesRepId: 'rep-9' } });
  });
  it('view_own without a rep → matches nothing', () => {
    expect(
      creditMemoScopeWhere(actor({ permissions: { 'credit_memos.view_own': true } })),
    ).toEqual({ id: MATCH_NONE });
  });
  it('no view permission → matches nothing', () => {
    expect(creditMemoScopeWhere(actor({}))).toEqual({ id: MATCH_NONE });
  });
});

describe('rmaScopeWhere', () => {
  it('all access → no restriction', () => {
    expect(rmaScopeWhere(actor({ isSuperAdmin: true }))).toEqual({});
    expect(
      rmaScopeWhere(actor({ permissions: { 'rmas.view_all': true } })),
    ).toEqual({});
  });
  it('view_own + linked rep → customer relation filter', () => {
    expect(
      rmaScopeWhere(
        actor({ permissions: { 'rmas.view_own': true }, salesRepId: 'rep-9' }),
      ),
    ).toEqual({ customer: { salesRepId: 'rep-9' } });
  });
  it('view_own without a rep → matches nothing', () => {
    expect(
      rmaScopeWhere(actor({ permissions: { 'rmas.view_own': true } })),
    ).toEqual({ id: MATCH_NONE });
  });
  it('no view permission → matches nothing', () => {
    expect(rmaScopeWhere(actor({}))).toEqual({ id: MATCH_NONE });
  });
});

describe('paymentScopeWhere', () => {
  it('all access → no restriction', () => {
    expect(paymentScopeWhere(actor({ isSuperAdmin: true }))).toEqual({});
    expect(
      paymentScopeWhere(actor({ permissions: { 'payments.view_all': true } })),
    ).toEqual({});
  });
  it('view_own + linked rep → customer relation filter', () => {
    expect(
      paymentScopeWhere(
        actor({ permissions: { 'payments.view_own': true }, salesRepId: 'rep-9' }),
      ),
    ).toEqual({ customer: { salesRepId: 'rep-9' } });
  });
  it('view_own without a rep → matches nothing', () => {
    expect(
      paymentScopeWhere(actor({ permissions: { 'payments.view_own': true } })),
    ).toEqual({ id: MATCH_NONE });
  });
  it('no view permission → matches nothing', () => {
    expect(paymentScopeWhere(actor({}))).toEqual({ id: MATCH_NONE });
  });
});

describe('dashboardScopeSalesRepId', () => {
  it('all access (super / view_all) → unscoped (null)', () => {
    expect(dashboardScopeSalesRepId(actor({ isSuperAdmin: true }))).toBeNull();
    expect(
      dashboardScopeSalesRepId(
        actor({ permissions: { 'sales_orders.view_all': true } }),
      ),
    ).toBeNull();
  });

  it('no SO view perm → unscoped (null) so non-rep roles are unaffected', () => {
    expect(dashboardScopeSalesRepId(actor({}))).toBeNull();
  });

  it('view_own with a linked rep → that salesRepId', () => {
    expect(
      dashboardScopeSalesRepId(
        actor({ permissions: { 'sales_orders.view_own': true }, salesRepId: 'rep-3' }),
      ),
    ).toBe('rep-3');
  });

  it('view_own without a linked rep → no-match sentinel', () => {
    expect(
      dashboardScopeSalesRepId(
        actor({ permissions: { 'sales_orders.view_own': true } }),
      ),
    ).toBe(MATCH_NONE);
  });
});
