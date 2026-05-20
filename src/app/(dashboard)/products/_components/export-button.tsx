'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Papa from 'papaparse';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Export column order + headers. Headers are chosen so the file re-imports
// cleanly through the import wizard's auto-detect (each normalizes to a
// known field alias). Keep in sync with the importable product fields.
type ExportProduct = {
  sku: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  brand: string | null;
  category: string | null;
  basePrice: string | null;
  weight: string | null;
  weightUnit: string | null;
  lengthDim: string | null;
  widthDim: string | null;
  heightDim: string | null;
  dimensionUnit: string | null;
  countryOfOrigin: string | null;
  hsCode: string | null;
  hazmat: boolean;
  active: boolean;
  type: string;
  imageUrl: string | null;
};

const COLUMNS: Array<{ header: string; value: (p: ExportProduct) => string }> = [
  { header: 'SKU', value: (p) => p.sku },
  { header: 'Name', value: (p) => p.name },
  { header: 'Short description', value: (p) => p.shortDescription ?? '' },
  { header: 'Long description', value: (p) => p.longDescription ?? '' },
  { header: 'Brand', value: (p) => p.brand ?? '' },
  { header: 'Category', value: (p) => p.category ?? '' },
  { header: 'Base price', value: (p) => p.basePrice ?? '' },
  { header: 'Weight', value: (p) => p.weight ?? '' },
  { header: 'Weight unit', value: (p) => p.weightUnit ?? '' },
  { header: 'Length', value: (p) => p.lengthDim ?? '' },
  { header: 'Width', value: (p) => p.widthDim ?? '' },
  { header: 'Height', value: (p) => p.heightDim ?? '' },
  { header: 'Dimension unit', value: (p) => p.dimensionUnit ?? '' },
  { header: 'Country of origin', value: (p) => p.countryOfOrigin ?? '' },
  { header: 'HS code', value: (p) => p.hsCode ?? '' },
  { header: 'Hazmat', value: (p) => (p.hazmat ? 'Yes' : 'No') },
  { header: 'Active', value: (p) => (p.active ? 'Yes' : 'No') },
  { header: 'Product type', value: (p) => p.type },
  { header: 'Image URL', value: (p) => p.imageUrl ?? '' },
];

function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function ExportButton() {
  const params = useSearchParams();
  const [pending, setPending] = useState(false);

  async function exportCsv() {
    setPending(true);
    try {
      // Carry the current list filters through to the export query so the
      // file matches what the operator is looking at.
      const qs = new URLSearchParams();
      for (const key of ['q', 'status', 'brand', 'category']) {
        const v = params.get(key);
        if (v) qs.set(key, v);
      }
      const res = await fetch(`/api/products/export?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? `Export failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { products: ExportProduct[] };
      if (data.products.length === 0) {
        toast.info('No products match the current filters.');
        return;
      }
      const rows = data.products.map((p) => {
        const row: Record<string, string> = {};
        for (const col of COLUMNS) row[col.header] = col.value(p);
        return row;
      });
      const csv = Papa.unparse(rows, { columns: COLUMNS.map((c) => c.header) });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `products-export-${today()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.products.length} products.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" onClick={exportCsv} disabled={pending}>
      <Download />
      {pending ? 'Exporting…' : 'Export'}
    </Button>
  );
}
