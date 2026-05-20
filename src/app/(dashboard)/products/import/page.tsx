import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { ImportWizard } from './_components/import-wizard';

export const metadata = { title: 'Import products' };

export default function ProductImportPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/products"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Products
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Import products
          </h1>
          <p className="text-sm text-muted-foreground">
            Upload a CSV of product master data. Each new product gets a
            default variant; no inventory is created.
          </p>
        </div>
      </div>

      <ImportWizard />
    </div>
  );
}
