'use client';

import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import type { CustomizableColumn } from './use-table-preferences';

// Reusable "Customize" control: a gear button → dropdown of column toggles
// + an optional image-default toggle. Controlled — pair it with
// useTablePreferences, which owns the state + persistence. Columns that
// require a permission the user lacks should be filtered out by the caller
// BEFORE being passed here (so they never appear as options).
export function TableCustomizer({
  columns,
  isVisible,
  onToggleColumn,
  showImages,
  onToggleImages,
  imageLabel = 'Show product images',
}: {
  columns: CustomizableColumn[];
  isVisible: (id: string) => boolean;
  onToggleColumn: (id: string) => void;
  // Omit the image section by leaving these undefined.
  showImages?: boolean;
  onToggleImages?: (v: boolean) => void;
  imageLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <Settings2 />
        Customize
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {columns.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={isVisible(c.id)}
            disabled={c.locked}
            // Keep the menu open so several columns can be toggled at once.
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => onToggleColumn(c.id)}
          >
            {c.label}
            {c.locked ? (
              <span className="ml-1 text-[10px] text-muted-foreground">
                always
              </span>
            ) : null}
          </DropdownMenuCheckboxItem>
        ))}
        {onToggleImages ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Images</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={!!showImages}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => onToggleImages(v === true)}
            >
              {imageLabel}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
