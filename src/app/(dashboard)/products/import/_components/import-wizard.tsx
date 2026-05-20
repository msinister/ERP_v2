'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import { toast } from 'sonner';
import {
  Upload,
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  PRODUCT_FIELDS,
  FIELD_BY_KEY,
  UNMAPPED,
  autoDetectMapping,
  normalizeHeader,
  type ProductFieldKey,
} from './import-fields';

const MAX_ROWS = 5000;
const BATCH_SIZE = 50;
const MAPPING_STORAGE_KEY = 'product-import-mapping-v1';

type RawRow = Record<string, string>;
type Mapping = Record<string, ProductFieldKey | typeof UNMAPPED>;
type ImportMode = 'skip' | 'update';

type RowValidation = {
  rowNumber: number;
  raw: RawRow;
  fields: Partial<Record<ProductFieldKey, string>>;
  sku: string;
  name: string;
  status: 'valid' | 'error' | 'exists';
  issues: string[];
};

type ServerResult = {
  rowNumber: number;
  sku: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  message?: string;
};

// ---------------------------------------------------------------------------
// localStorage helpers (saved per-header preferences for reuse)
// ---------------------------------------------------------------------------

function loadSavedMapping(): Record<string, ProductFieldKey> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MAPPING_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProductFieldKey>) : {};
  } catch {
    return {};
  }
}

function saveMapping(headers: string[], mapping: Mapping) {
  if (typeof window === 'undefined') return;
  try {
    const saved = loadSavedMapping();
    for (const h of headers) {
      const m = mapping[h];
      if (m && m !== UNMAPPED) saved[normalizeHeader(h)] = m;
    }
    window.localStorage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* ignore quota / serialization errors */
  }
}

// ---------------------------------------------------------------------------

function resolveRow(raw: RawRow, mapping: Mapping) {
  const out: Partial<Record<ProductFieldKey, string>> = {};
  for (const [header, fieldKey] of Object.entries(mapping)) {
    if (fieldKey === UNMAPPED) continue;
    const existing = out[fieldKey];
    if (existing != null && existing !== '') continue; // first column wins
    out[fieldKey] = (raw[header] ?? '').trim();
  }
  return out;
}

export function ImportWizard() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<RawRow[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [mode, setMode] = useState<ImportMode>('skip');
  const [existingSkus, setExistingSkus] = useState<Set<string>>(new Set());
  const [checkingSkus, setCheckingSkus] = useState(false);

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ServerResult[] | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // -------------------------------------------------------------------------
  // Step 1 — parse
  // -------------------------------------------------------------------------

  function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) {
      toast.error('Please upload a .csv file.');
      return;
    }
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const fields = (res.meta.fields ?? []).filter((f) => f.trim() !== '');
        if (fields.length === 0) {
          toast.error('No column headers found in the file.');
          return;
        }
        if (res.data.length === 0) {
          toast.error('No data rows found in the file.');
          return;
        }
        if (res.data.length > MAX_ROWS) {
          toast.error(
            `File has ${res.data.length.toLocaleString()} rows — the limit is ${MAX_ROWS.toLocaleString()}. Split the file and try again.`,
          );
          return;
        }
        setFileName(file.name);
        setHeaders(fields);
        setRows(res.data);
        setMapping(autoDetectMapping(fields, loadSavedMapping()));
        setResults(null);
        setStep(2);
      },
      error: (err) => {
        toast.error(`Could not parse file: ${err.message}`);
      },
    });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // -------------------------------------------------------------------------
  // Step 2 — mapping
  // -------------------------------------------------------------------------

  const skuMapped = Object.values(mapping).includes('sku');
  const nameMapped = Object.values(mapping).includes('name');

  function setColumnField(header: string, value: ProductFieldKey | typeof UNMAPPED) {
    setMapping((prev) => ({ ...prev, [header]: value }));
  }

  async function goToValidation() {
    saveMapping(headers, mapping);
    // Look up which SKUs already exist in the DB.
    const skuColumn = Object.entries(mapping).find(
      ([, f]) => f === 'sku',
    )?.[0];
    const skus = skuColumn
      ? Array.from(
          new Set(
            rows.map((r) => (r[skuColumn] ?? '').trim()).filter(Boolean),
          ),
        )
      : [];
    setCheckingSkus(true);
    try {
      const res = await fetch('/api/products/check-skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus }),
      });
      if (res.ok) {
        const data = (await res.json()) as { existing: string[] };
        setExistingSkus(new Set(data.existing));
      } else {
        setExistingSkus(new Set());
        toast.error('Could not check existing SKUs — continuing without DB flags.');
      }
    } catch {
      setExistingSkus(new Set());
      toast.error('Could not check existing SKUs — continuing without DB flags.');
    } finally {
      setCheckingSkus(false);
      setStep(3);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — validation
  // -------------------------------------------------------------------------

  const validations: RowValidation[] = useMemo(() => {
    const seen = new Map<string, number>();
    return rows.map((raw, i) => {
      const fields = resolveRow(raw, mapping);
      const sku = (fields.sku ?? '').trim();
      const name = (fields.name ?? '').trim();
      const issues: string[] = [];
      if (!sku) issues.push('Missing SKU');
      if (!name) issues.push('Missing Name');
      if (sku) {
        const count = seen.get(sku) ?? 0;
        seen.set(sku, count + 1);
        if (count > 0) issues.push('Duplicate SKU in file');
      }
      const imageUrl = (fields.imageUrl ?? '').trim();
      if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
        issues.push('Invalid image URL');
      }
      let status: RowValidation['status'];
      if (issues.length > 0) status = 'error';
      else if (existingSkus.has(sku)) status = 'exists';
      else status = 'valid';
      return { rowNumber: i + 2, raw, fields, sku, name, status, issues };
    });
  }, [rows, mapping, existingSkus]);

  const errorRows = validations.filter((v) => v.status === 'error');
  const existingRows = validations.filter((v) => v.status === 'exists');
  const importableRows = validations.filter((v) => v.status !== 'error');

  // -------------------------------------------------------------------------
  // Step 4 — import
  // -------------------------------------------------------------------------

  async function runImport() {
    setImporting(true);
    setProgress(0);
    setResults(null);
    setStep(4);

    const payload = importableRows.map((v) => ({ rowNumber: v.rowNumber, ...v.fields }));
    const all: ServerResult[] = [];
    let processed = 0;
    try {
      for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const batch = payload.slice(i, i + BATCH_SIZE);
        const res = await fetch('/api/products/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, rows: batch }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Import failed (${res.status})`);
        }
        const data = (await res.json()) as { results: ServerResult[] };
        all.push(...data.results);
        processed += batch.length;
        setProgress(Math.round((processed / payload.length) * 100));
      }
      setResults(all);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
      // Keep whatever completed so the operator can see partial results.
      setResults(all.length > 0 ? all : null);
    } finally {
      setImporting(false);
    }
  }

  function downloadErrorCsv() {
    // Client validation errors (skipped before import) + server errors.
    const serverErrors = (results ?? []).filter((r) => r.status === 'error');
    const serverErrorByRow = new Map(serverErrors.map((r) => [r.rowNumber, r.message ?? 'Error']));
    const rowsForCsv: Array<RawRow & { _error: string }> = [];
    for (const v of validations) {
      const serverMsg = serverErrorByRow.get(v.rowNumber);
      if (v.status === 'error') {
        rowsForCsv.push({ ...v.raw, _error: v.issues.join('; ') });
      } else if (serverMsg) {
        rowsForCsv.push({ ...v.raw, _error: serverMsg });
      }
    }
    if (rowsForCsv.length === 0) {
      toast.info('No error rows to download.');
      return;
    }
    const csv = Papa.unparse(rowsForCsv, { columns: [...headers, '_error'] });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `import-errors-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setStep(1);
    setFileName('');
    setHeaders([]);
    setRows([]);
    setMapping({});
    setExistingSkus(new Set());
    setResults(null);
    setProgress(0);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 1 ? (
        <Card>
          <CardContent className="pt-6">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={
                'flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center transition-colors ' +
                (dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50')
              }
            >
              <Upload className="size-8 text-muted-foreground" />
              <div className="text-sm font-medium">
                Drop a CSV file here, or click to browse
              </div>
              <div className="text-xs text-muted-foreground">
                .csv only · up to {MAX_ROWS.toLocaleString()} rows · product
                master data (no inventory)
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = '';
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <PreviewCard fileName={fileName} headers={headers} rows={rows} />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Map columns</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Match each file column to a product field. SKU and Name are
                required. Auto-detected from your headers — adjust as needed.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {headers.map((header) => (
                <div
                  key={header}
                  className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{header}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      e.g. {String(rows[0]?.[header] ?? '—').slice(0, 40) || '—'}
                    </div>
                  </div>
                  <Select
                    value={mapping[header] ?? UNMAPPED}
                    onValueChange={(v) =>
                      setColumnField(
                        header,
                        (v as ProductFieldKey | typeof UNMAPPED) ?? UNMAPPED,
                      )
                    }
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {(v) =>
                          v === UNMAPPED || v == null
                            ? 'Don’t import'
                            : FIELD_BY_KEY[v as ProductFieldKey].label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED}>Don&apos;t import</SelectItem>
                      {PRODUCT_FIELDS.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                          {f.required ? ' *' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft />
              Back
            </Button>
            <div className="flex items-center gap-3">
              {!skuMapped || !nameMapped ? (
                <span className="text-xs text-destructive">
                  Map both SKU and Name to continue.
                </span>
              ) : null}
              <Button
                onClick={goToValidation}
                disabled={!skuMapped || !nameMapped || checkingSkus}
              >
                {checkingSkus ? 'Checking…' : 'Continue'}
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-sm">Validation</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {importableRows.length} of {validations.length} rows valid
                  {errorRows.length > 0
                    ? ` · ${errorRows.length} will be skipped`
                    : ''}
                  {existingRows.length > 0
                    ? ` · ${existingRows.length} already exist`
                    : ''}
                </p>
              </div>
              {existingRows.length > 0 ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor="import-mode" className="text-xs">
                    Existing SKUs:
                  </Label>
                  <Select
                    value={mode}
                    onValueChange={(v) => setMode((v as ImportMode) ?? 'skip')}
                  >
                    <SelectTrigger id="import-mode" className="w-40">
                      <SelectValue>
                        {(v) => (v === 'update' ? 'Update existing' : 'Skip existing')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">Skip existing</SelectItem>
                      <SelectItem value="update">Update existing</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="px-0">
              <div className="max-h-[420px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead className="w-10 pl-6">Row</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="pr-6">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validations.slice(0, 500).map((v) => (
                      <TableRow key={v.rowNumber}>
                        <TableCell className="pl-6 text-xs text-muted-foreground tabular-nums">
                          {v.rowNumber}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {v.sku || (
                            <span className="text-destructive">— missing —</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[28ch] truncate text-sm">
                          {v.name || (
                            <span className="text-destructive">— missing —</span>
                          )}
                        </TableCell>
                        <TableCell className="pr-6">
                          <RowStatusBadge v={v} mode={mode} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {validations.length > 500 ? (
                  <p className="px-6 py-3 text-xs text-muted-foreground">
                    Showing first 500 of {validations.length} rows. All valid
                    rows will be imported.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setStep(2)}>
              <ChevronLeft />
              Back to mapping
            </Button>
            <Button onClick={runImport} disabled={importableRows.length === 0}>
              <Upload />
              Import {importableRows.length} product
              {importableRows.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {importing ? 'Importing…' : 'Import complete'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">{progress}%</div>

            {results ? (
              <ResultsSummary
                results={results}
                onDownloadErrors={downloadErrorCsv}
                onReset={reset}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Stepper({ step }: { step: number }) {
  const labels = ['Upload', 'Map columns', 'Validate', 'Import'];
  return (
    <div className="flex items-center gap-2 text-xs">
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={
                'flex size-5 items-center justify-center rounded-full text-[10px] font-semibold ' +
                (active
                  ? 'bg-primary text-primary-foreground'
                  : done
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground')
              }
            >
              {n}
            </span>
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>
              {label}
            </span>
            {n < labels.length ? (
              <ChevronRight className="size-3 text-muted-foreground/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PreviewCard({
  fileName,
  headers,
  rows,
}: {
  fileName: string;
  headers: string[];
  rows: RawRow[];
}) {
  const preview = rows.slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="size-4" />
          {fileName}
          <Badge variant="outline" className="ml-1 text-muted-foreground">
            {rows.length.toLocaleString()} rows
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                {headers.map((h) => (
                  <TableHead key={h} className="whitespace-nowrap">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.map((r, i) => (
                <TableRow key={i}>
                  {headers.map((h) => (
                    <TableCell
                      key={h}
                      className="max-w-[24ch] truncate whitespace-nowrap text-xs"
                    >
                      {r[h] ?? ''}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RowStatusBadge({ v, mode }: { v: RowValidation; mode: ImportMode }) {
  if (v.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <XCircle className="size-3.5" />
        {v.issues.join('; ')}
      </span>
    );
  }
  if (v.status === 'exists') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
        <AlertTriangle className="size-3.5" />
        Already exists — will {mode === 'update' ? 'update' : 'skip'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
      <CheckCircle2 className="size-3.5" />
      Valid
    </span>
  );
}

function ResultsSummary({
  results,
  onDownloadErrors,
  onReset,
}: {
  results: ServerResult[];
  onDownloadErrors: () => void;
  onReset: () => void;
}) {
  const created = results.filter((r) => r.status === 'created').length;
  const updated = results.filter((r) => r.status === 'updated').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors = results.filter((r) => r.status === 'error').length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Created" value={created} tone="green" />
        <Stat label="Updated" value={updated} tone="blue" />
        <Stat label="Skipped" value={skipped} tone="muted" />
        <Stat label="Errors" value={errors} tone="red" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {errors > 0 ? (
          <Button variant="outline" size="sm" onClick={onDownloadErrors}>
            Download error rows (CSV)
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onReset}>
          Import another file
        </Button>
        <Button size="sm" render={<Link href="/products" />}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'blue' | 'red' | 'muted';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-green-600'
      : tone === 'blue'
        ? 'text-blue-600'
        : tone === 'red'
          ? value > 0
            ? 'text-destructive'
            : 'text-muted-foreground'
          : 'text-muted-foreground';
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={'mt-0.5 text-xl font-semibold tabular-nums ' + toneClass}>
        {value}
      </div>
    </div>
  );
}
