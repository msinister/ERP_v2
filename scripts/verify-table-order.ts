/**
 * Pure-function check for the column order/reorder helpers behind the
 * draggable customizer.  npx tsx scripts/verify-table-order.ts
 */
import { resolveOrder, reorderColumnIds } from '../src/components/shared/table-order';

const COLS = [
  { id: 'sku', locked: true },
  { id: 'name' },
  { id: 'brand' },
  { id: 'vendor' },
  { id: 'status' },
  { id: 'createdAt' },
];

function ok(m: string) { console.log(`  [OK]   ${m}`); }
function fail(m: string): never { console.error(`  [FAIL] ${m}`); throw new Error(m); }
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fail(`${label}: expected ${w}, got ${g}`);
  ok(`${label} → ${g}`);
}

// --- resolveOrder ---
eq('default (no saved)', resolveOrder(COLS, []), ['sku', 'name', 'brand', 'vendor', 'status', 'createdAt']);
eq('partial saved (vendor,name) + locked pinned + rest in def order',
  resolveOrder(COLS, ['vendor', 'name']),
  ['sku', 'vendor', 'name', 'brand', 'status', 'createdAt']);
eq('unknown id dropped',
  resolveOrder(COLS, ['ghost', 'brand']),
  ['sku', 'brand', 'name', 'vendor', 'status', 'createdAt']);
eq('saved includes locked sku → sku stays pinned, not double-listed',
  resolveOrder(COLS, ['sku', 'vendor']),
  ['sku', 'vendor', 'name', 'brand', 'status', 'createdAt']);

// --- reorderColumnIds (currentOrder = [] → default) ---
eq('move brand before name',
  reorderColumnIds(COLS, [], 'brand', 'name'),
  ['sku', 'brand', 'name', 'vendor', 'status', 'createdAt']);
eq('move name down before createdAt',
  reorderColumnIds(COLS, [], 'name', 'createdAt'),
  ['sku', 'brand', 'vendor', 'status', 'name', 'createdAt']);
eq('moving locked sku → no-op (null)', reorderColumnIds(COLS, [], 'sku', 'name'), null);
eq('drop onto self → no-op (null)', reorderColumnIds(COLS, [], 'name', 'name'), null);
eq('unknown active → no-op (null)', reorderColumnIds(COLS, [], 'ghost', 'name'), null);

// Chained: reorder then resolve round-trips stably.
const moved = reorderColumnIds(COLS, [], 'vendor', 'name')!;
eq('round-trip: resolve(reordered) === reordered', resolveOrder(COLS, moved), moved);

console.log('\n✅ Table order helpers verified.\n');
