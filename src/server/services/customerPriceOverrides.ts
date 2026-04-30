import { AuditAction, CustomerActivityKind, Prisma } from '@/generated/tenant';
import type {
  CustomerPriceOverride,
  PrismaClient,
} from '@/generated/tenant';
import { audit, type AuditContext } from '@/lib/audit/audit';
import {
  bulkPriceOverrideCsvRowSchema,
  createPriceOverrideInputSchema,
  type CreatePriceOverrideInput,
} from '@/lib/validation/customers';

// Customer-specific price overrides. Wired into the resolver as the
// CUSTOMER_SPECIFIC branch — see src/lib/pricing/resolve.ts.
//
// Uniqueness on (customerId, variantId) is enforced by the partial
// unique index `customerpriceoverride_active_key` (only over rows where
// deletedAt IS NULL). Soft-deleting an override frees up the slot so a
// fresh override for the same pair can be created without conflict.

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createOverride(
  db: PrismaClient,
  customerId: string,
  input: CreatePriceOverrideInput,
  ctx?: AuditContext,
): Promise<CustomerPriceOverride> {
  const data = createPriceOverrideInputSchema.parse(input);
  return db.$transaction(async (tx) => {
    const created = await tx.customerPriceOverride.create({
      data: {
        customerId,
        variantId: data.variantId,
        unitPrice: new Prisma.Decimal(data.unitPrice),
        currency: data.currency ?? 'USD',
        notes: data.notes ?? null,
      },
    });
    await audit(tx, {
      action: AuditAction.CREATE,
      entityType: 'CustomerPriceOverride',
      entityId: created.id,
      after: created,
      ctx,
    });
    return created;
  });
}

export async function updateOverride(
  db: PrismaClient,
  id: string,
  input: { unitPrice?: string; currency?: string | null; notes?: string | null },
  ctx?: AuditContext,
): Promise<CustomerPriceOverride> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerPriceOverride.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerPriceOverride not found: ${id}`);
    if (before.deletedAt) throw new Error('CustomerPriceOverride is soft-deleted');

    const updateData: Prisma.CustomerPriceOverrideUpdateInput = {};
    if (input.unitPrice !== undefined) {
      updateData.unitPrice = new Prisma.Decimal(input.unitPrice);
    }
    if ('currency' in input) updateData.currency = input.currency ?? null;
    if ('notes' in input) updateData.notes = input.notes ?? null;

    const after = await tx.customerPriceOverride.update({
      where: { id },
      data: updateData,
    });
    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'CustomerPriceOverride',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function softDeleteOverride(
  db: PrismaClient,
  id: string,
  ctx?: AuditContext,
): Promise<CustomerPriceOverride> {
  return db.$transaction(async (tx) => {
    const before = await tx.customerPriceOverride.findUnique({ where: { id } });
    if (!before) throw new Error(`CustomerPriceOverride not found: ${id}`);
    if (before.deletedAt) {
      throw new Error('CustomerPriceOverride is already soft-deleted');
    }
    const after = await tx.customerPriceOverride.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(tx, {
      action: AuditAction.DELETE,
      entityType: 'CustomerPriceOverride',
      entityId: id,
      before,
      after,
      ctx,
    });
    return after;
  });
}

export async function getOverride(
  db: PrismaClient,
  id: string,
): Promise<CustomerPriceOverride | null> {
  return db.customerPriceOverride.findFirst({
    where: { id, deletedAt: null },
  });
}

export async function listOverridesForCustomer(
  db: PrismaClient,
  customerId: string,
): Promise<CustomerPriceOverride[]> {
  return db.customerPriceOverride.findMany({
    where: { customerId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// Bulk CSV import
// ---------------------------------------------------------------------------

export type CsvImportError = {
  row: number; // 1-indexed, excluding the header row
  sku: string | null;
  message: string;
};

export type CsvImportResult = {
  created: number;
  updated: number;
  errors: CsvImportError[];
};

/**
 * Bulk-upsert price overrides for a single customer from a CSV blob.
 *
 * CSV format (header row REQUIRED):
 *   sku,unitPrice[,currency,notes]
 *
 * Behavior contract — UPSERT-ONLY. Rows present in the CSV are
 * inserted (new) or updated (existing match on (customerId, variantId)
 * among non-deleted rows). Rows that are NOT in the CSV are LEFT
 * ALONE — never deleted, never deactivated, never modified by this
 * path. Use softDeleteOverride() for explicit removals.
 *
 * Per-row failures (unknown SKU, malformed price, etc.) DO NOT abort
 * the whole import; the row is recorded in the returned errors array
 * with its 1-indexed row number, the SKU we tried to look up, and a
 * human-readable message. The successful rows still commit.
 *
 * Audit footprint is summary-only — one AuditLog row of action UPDATE
 * with afterJson = { created, updated, errorCount } — and one
 * CustomerActivity AUTO row with summary 'price_overrides_imported'.
 * Per-row audit would flood the log with nothing actionable; the
 * summary is the right granularity. Individual create/update audit
 * rows (which the per-row CRUD paths emit) are intentionally NOT
 * written here.
 */
export async function bulkImportFromCsv(
  db: PrismaClient,
  customerId: string,
  csvText: string,
  ctx?: AuditContext,
): Promise<CsvImportResult> {
  const parsedRows = parseCsv(csvText);

  return db.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    const errors: CsvImportError[] = [];

    for (const { rowNumber, raw } of parsedRows.rows) {
      const validation = bulkPriceOverrideCsvRowSchema.safeParse(raw);
      if (!validation.success) {
        errors.push({
          row: rowNumber,
          sku: typeof raw.sku === 'string' ? raw.sku : null,
          message: validation.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        });
        continue;
      }
      const row = validation.data;

      try {
        const variant = await tx.productVariant.findFirst({
          where: { sku: row.sku, deletedAt: null },
          select: { id: true },
        });
        if (!variant) {
          errors.push({
            row: rowNumber,
            sku: row.sku,
            message: `unknown SKU: ${row.sku}`,
          });
          continue;
        }

        const existing = await tx.customerPriceOverride.findFirst({
          where: { customerId, variantId: variant.id, deletedAt: null },
        });

        if (existing) {
          await tx.customerPriceOverride.update({
            where: { id: existing.id },
            data: {
              unitPrice: new Prisma.Decimal(row.unitPrice),
              currency: row.currency ?? existing.currency,
              notes: row.notes ?? existing.notes,
            },
          });
          updated += 1;
        } else {
          await tx.customerPriceOverride.create({
            data: {
              customerId,
              variantId: variant.id,
              unitPrice: new Prisma.Decimal(row.unitPrice),
              currency: row.currency ?? 'USD',
              notes: row.notes ?? null,
            },
          });
          created += 1;
        }
      } catch (e) {
        errors.push({
          row: rowNumber,
          sku: row.sku,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Schema-level malformations from the parser (missing columns etc.)
    // come through as errors with rowNumber=0 — surface them too.
    for (const e of parsedRows.headerErrors) errors.push(e);

    await audit(tx, {
      action: AuditAction.UPDATE,
      entityType: 'Customer',
      entityId: customerId,
      after: {
        operation: 'price_overrides_imported',
        created,
        updated,
        errorCount: errors.length,
      },
      ctx,
    });
    await tx.customerActivity.create({
      data: {
        customerId,
        kind: CustomerActivityKind.AUTO,
        summary: 'price_overrides_imported',
        detailJson: { created, updated, errors: errors.length },
        createdById: ctx?.userId ?? null,
      },
    });

    return { created, updated, errors };
  });
}

// ---------------------------------------------------------------------------
// Internal CSV parser
// ---------------------------------------------------------------------------

type ParsedRow = {
  rowNumber: number; // 1-indexed in the data section (excludes header)
  raw: Record<string, unknown>;
};

type ParseResult = {
  rows: ParsedRow[];
  headerErrors: CsvImportError[];
};

// Minimal RFC 4180-ish CSV: comma-separated, double-quote-wrapped values
// allow embedded commas, "" inside quotes is a literal quote. No newline
// inside quoted fields (the price/notes columns won't contain them in
// pilot — keep the parser small and dependency-free). Anything more
// exotic should live behind csv-parse later.
function parseCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { rows: [], headerErrors: [] };
  }
  const header = parseLine(lines[0]).map((h) => h.trim());
  const requiredCols = ['sku', 'unitPrice'];
  const headerErrors: CsvImportError[] = [];
  for (const col of requiredCols) {
    if (!header.includes(col)) {
      headerErrors.push({
        row: 0,
        sku: null,
        message: `missing required column: ${col}`,
      });
    }
  }

  const rows: ParsedRow[] = [];
  if (headerErrors.length > 0) {
    return { rows: [], headerErrors };
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const raw: Record<string, unknown> = {};
    for (let j = 0; j < header.length; j++) {
      raw[header[j]] = cells[j] !== undefined ? cells[j] : undefined;
    }
    rows.push({ rowNumber: i, raw });
  }
  return { rows, headerErrors };
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
