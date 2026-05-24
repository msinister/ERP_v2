/**
 * Pure-function check for the SO total helpers that drive the deposit
 * dialog's "Order Total" (Confirmed) vs "Balance Due" (Dispatched) figures.
 *   npx tsx scripts/verify-so-shipped-total.ts
 * No DB — constructs fake orders and asserts the computed totals.
 */
import { Prisma } from '../src/generated/tenant';
import type { SalesOrder, SalesOrderLine } from '../src/generated/tenant';
import {
  computeSalesOrderShippedTotal,
  computeSalesOrderTotal,
  computeSalesOrderDisplayTotal,
} from '../src/lib/ar/openSos';

type SO = Parameters<typeof computeSalesOrderTotal>[0];
const D = (n: string | number) => new Prisma.Decimal(n);

function ok(m: string) { console.log(`  [OK]   ${m}`); }
function fail(m: string): never { console.error(`  [FAIL] ${m}`); throw new Error(m); }
function eq(label: string, got: Prisma.Decimal, want: string) {
  if (got.toString() !== want) fail(`${label}: expected ${want}, got ${got.toString()}`);
  ok(`${label} = ${got.toString()}`);
}

function line(partial: Partial<SalesOrderLine>): SalesOrderLine {
  return {
    qtyOrdered: D(0),
    qtyShipped: D(0),
    unitPrice: D(0),
    discountPercent: null,
    discountAmount: null,
    deletedAt: null,
    ...partial,
  } as SalesOrderLine;
}

function so(status: string, lines: SalesOrderLine[], adj?: Partial<SalesOrder>): SO {
  return {
    status,
    orderDiscountAmount: null,
    orderDiscountPercent: null,
    shippingAmount: null,
    handlingAmount: null,
    ...adj,
    lines,
  } as unknown as SO;
}

function main() {
  console.log('\nVerify SO total helpers\n');

  // 2 lines: L1 ordered 10 / shipped 4 @ $10; L2 ordered 5 / shipped 0 @ $20.
  const lines = [
    line({ qtyOrdered: D(10), qtyShipped: D(4), unitPrice: D(10) }),
    line({ qtyOrdered: D(5), qtyShipped: D(0), unitPrice: D(20) }),
  ];

  // Confirmed Order Total = quoted (qtyOrdered): 10*10 + 5*20 = 200.
  eq('Confirmed Order Total (quoted)', computeSalesOrderTotal(so('CONFIRMED', lines)), '200');

  // Dispatched Balance Due = strict shipped: 4*10 + 0*20 = 40 (L2 excluded).
  eq('Dispatched Balance Due (strict shipped)', computeSalesOrderShippedTotal(so('DISPATCHED', lines)), '40');

  // Contrast: displayTotal falls back to qtyOrdered for the 0-shipped line:
  // 4*10 + 5*20 = 140 — which is why a strict helper was needed.
  eq('(contrast) Dispatched displayTotal', computeSalesOrderDisplayTotal(so('DISPATCHED', lines)), '140');

  // Order-level adjustments flow through the shipped total: shipped 40,
  // − $5 discount + $7 shipping + $3 handling = 45.
  const adj = { orderDiscountAmount: D(5), shippingAmount: D(7), handlingAmount: D(3) };
  eq(
    'Dispatched Balance Due with adjustments',
    computeSalesOrderShippedTotal(so('DISPATCHED', lines, adj)),
    '45',
  );

  // Line discount honored on shipped value: shipped 4*10=40 − 25% = 30.
  const discounted = [line({ qtyOrdered: D(10), qtyShipped: D(4), unitPrice: D(10), discountPercent: D(25) })];
  eq('Shipped value with line % discount', computeSalesOrderShippedTotal(so('DISPATCHED', discounted)), '30');

  console.log('\n✅ SO total helpers verified.\n');
}

main();
