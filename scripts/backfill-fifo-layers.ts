/**
 * CLI wrapper for src/server/services/backfillFifoLayers.
 *
 *   npx tsx scripts/backfill-fifo-layers.ts                        # scan + backfill, write to DB
 *   npx tsx scripts/backfill-fifo-layers.ts --dry-run              # scan + report only, no writes
 *   npx tsx scripts/backfill-fifo-layers.ts --overrides=path.json  # supply unitCost for case-3 movements
 *   npx tsx scripts/backfill-fifo-layers.ts --movement-ids=id1,id2 # restrict scan to specific movements
 *   npx tsx scripts/backfill-fifo-layers.ts --verbose              # per-movement decisions in addition to summary
 *   npx tsx scripts/backfill-fifo-layers.ts --help                 # print usage and exit
 *
 * Combined example:
 *   npx tsx scripts/backfill-fifo-layers.ts --overrides=overrides.json --movement-ids=cmoa,cmob --verbose
 *
 * Overrides file format:
 *   { "<movementId>": "<unitCost>", ... }
 *   unitCost can be a string ("12.50") or a number (12.5). Decimal precision is preserved.
 *
 * Exit codes:
 *   0 — scan completed (skips in the structured output do NOT cause non-zero exit)
 *   1 — fatal error (DB connection failure, malformed override file, schema mismatch)
 *
 * Per-movement transaction shape: each movement is processed independently inside
 * the service. A single failure lands in the result's skipped[] with reason
 * 'transaction_failed' and the loop continues. There is no --keep-going flag —
 * resilience is implicit (Q1 of the design discovery).
 */

import { readFileSync } from 'node:fs';
import { Prisma } from '../src/generated/tenant';
import { db } from '../src/lib/db';
import {
  backfillFifoLayers,
  type BackfillFifoLayersInput,
  type BackfillResult,
  type BackfillSkipReason,
} from '../src/server/services/backfillFifoLayers';

// =============================================================================
// argv parsing — inline, no extra deps
// =============================================================================

type ParsedArgs = {
  overridesPath: string | null;
  movementIds: string[] | null;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    overridesPath: null,
    movementIds: null,
    dryRun: false,
    verbose: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--verbose') {
      out.verbose = true;
    } else if (arg.startsWith('--overrides=')) {
      out.overridesPath = arg.slice('--overrides='.length);
      if (out.overridesPath.length === 0) {
        throw new Error(
          '--overrides=<path> requires a non-empty path (got empty string)',
        );
      }
    } else if (arg.startsWith('--movement-ids=')) {
      const csv = arg.slice('--movement-ids='.length);
      if (csv.length === 0) {
        throw new Error(
          '--movement-ids=<csv> requires a non-empty comma-separated list',
        );
      }
      out.movementIds = csv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (out.movementIds.length === 0) {
        throw new Error(
          '--movement-ids=<csv> parsed to an empty list; check for stray commas',
        );
      }
    } else {
      throw new Error(
        `unknown argument: '${arg}' (use --help for usage)`,
      );
    }
  }
  return out;
}

const USAGE = `Usage: npx tsx scripts/backfill-fifo-layers.ts [options]

Options:
  --overrides=<path>      JSON file mapping movementId → unitCost. Used to
                          recover case-3 movements (no movement.unitCost,
                          no ReceiptLine link).
  --movement-ids=<csv>    Comma-separated movement IDs. Restricts the scan
                          to these IDs. When omitted, all RECEIVE movements
                          are scanned.
  --dry-run               Compute what would be backfilled and print the
                          report without writing to the DB.
  --verbose               Print per-movement decisions in addition to the
                          summary.
  --help, -h              Show this message and exit.

Exit codes:
  0   Scan completed. Skipped movements are normal output, not errors.
  1   Fatal error (DB connection, malformed override file, schema mismatch).
`;

// =============================================================================
// Override loading
// =============================================================================

function loadOverrides(
  path: string,
): Record<string, string | number | Prisma.Decimal> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not read overrides file '${path}': ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`overrides file '${path}' is not valid JSON: ${msg}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `overrides file '${path}' must be a JSON object mapping movementId → unitCost`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new Error(
        `overrides[${k}] must be a string or number (got ${typeof v})`,
      );
    }
    out[k] = v;
  }
  return out;
}

// =============================================================================
// Output helpers
// =============================================================================

let stageNum = 0;
function stage(label: string) {
  stageNum += 1;
  console.log('\n' + '='.repeat(64));
  console.log(`STAGE ${stageNum}: ${label}`);
  console.log('='.repeat(64));
}
function info(msg: string) {
  console.log(`  ${msg}`);
}

function printSummary(result: BackfillResult, dryRun: boolean): void {
  stage(dryRun ? 'Summary (DRY RUN — no DB writes)' : 'Summary');
  info(`totalScanned          ${result.totalScanned}`);
  info(`totalBackfilled       ${result.totalBackfilled}`);
  info(`totalSkipped          ${result.totalSkipped}`);
  info(`totalAlreadyHasLayer  ${result.totalAlreadyHasLayer}`);
  info('');
  info('byCase:');
  info(`  fromMovement     ${result.byCase.fromMovement}`);
  info(`  fromReceiptLine  ${result.byCase.fromReceiptLine}`);
  info(`  fromOverride     ${result.byCase.fromOverride}`);
}

function printSkipped(result: BackfillResult): void {
  if (result.skipped.length === 0) return;
  stage('Skipped movements (grouped by reason)');
  const byReason = new Map<BackfillSkipReason, BackfillResult['skipped']>();
  for (const s of result.skipped) {
    const bucket = byReason.get(s.reason) ?? [];
    bucket.push(s);
    byReason.set(s.reason, bucket);
  }
  // Stable order across runs.
  const orderedReasons: BackfillSkipReason[] = [
    'irrecoverable_no_cost_data',
    'negative_qty',
    'untracked_consume_in_bin',
    'transaction_failed',
  ];
  for (const reason of orderedReasons) {
    const rows = byReason.get(reason);
    if (!rows || rows.length === 0) continue;
    info(`${reason} (${rows.length}):`);
    for (const r of rows) {
      info(`  ${r.movementId}  ${r.details ?? ''}`);
    }
  }
}

function printBackfilled(result: BackfillResult, dryRun: boolean): void {
  if (result.backfilled.length === 0) return;
  stage(dryRun ? 'Would backfill' : 'Backfilled movements');
  info(
    [
      'movementId'.padEnd(28),
      'layerId'.padEnd(28),
      'qty'.padStart(12),
      'unitCost'.padStart(12),
      'source',
    ].join('  '),
  );
  info('-'.repeat(96));
  for (const b of result.backfilled) {
    info(
      [
        b.movementId.padEnd(28),
        b.layerId.padEnd(28),
        b.qty.padStart(12),
        b.unitCost.padStart(12),
        b.source,
      ].join('  '),
    );
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error parsing arguments: ${msg}`);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  stage('Configuration');
  info(`dryRun         ${parsed.dryRun}`);
  info(`verbose        ${parsed.verbose}`);
  info(
    `overridesPath  ${parsed.overridesPath ?? '(none)'}`,
  );
  info(
    `movementIds    ${parsed.movementIds ? `[${parsed.movementIds.length}] ${parsed.movementIds.join(', ')}` : '(scan all)'}`,
  );

  // Load overrides up-front so file errors fail fast before any DB work.
  const input: BackfillFifoLayersInput = {
    dryRun: parsed.dryRun,
  };
  if (parsed.overridesPath) {
    stage('Load overrides');
    input.overrides = loadOverrides(parsed.overridesPath);
    info(
      `loaded ${Object.keys(input.overrides).length} override entries from ${parsed.overridesPath}`,
    );
    if (parsed.verbose) {
      for (const [k, v] of Object.entries(input.overrides)) {
        info(`  ${k} → ${v}`);
      }
    }
  }
  if (parsed.movementIds) {
    input.movementIds = parsed.movementIds;
  }

  stage('Run backfill');
  const result = await backfillFifoLayers(db, input);

  printSummary(result, parsed.dryRun);
  printSkipped(result);
  // Verbose mode prints the per-movement backfill table; non-verbose still
  // prints the table because it's the load-bearing operator output. The
  // verbose-vs-not distinction is only the override echo at load time.
  printBackfilled(result, parsed.dryRun);

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error('\n--- BACKFILL FATAL ERROR ---');
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
