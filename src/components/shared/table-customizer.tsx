'use client';

import { useState } from 'react';
import { GripVertical, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { CustomizableColumn } from './use-table-preferences';

// Reusable "Customize" control: a gear button → popover with a sortable,
// toggleable column list + an optional image-default toggle. Controlled —
// pair it with useTablePreferences, which owns the state + persistence.
//
// `columns` MUST already be in display order (the page passes the resolved
// order). Locked columns (e.g. SKU) render pinned, without a drag handle, and
// aren't valid drop targets — they stay first. Permission-gated columns the
// user lacks should be filtered out by the caller before being passed here.
//
// Reorder uses native HTML5 drag-and-drop (no dependency): drag a row onto
// another to drop it just before that row.
export function TableCustomizer({
  columns,
  isVisible,
  onToggleColumn,
  onReorder,
  showImages,
  onToggleImages,
  imageLabel = 'Show product images',
}: {
  columns: CustomizableColumn[];
  isVisible: (id: string) => boolean;
  onToggleColumn: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  // Omit the image section by leaving these undefined.
  showImages?: boolean;
  onToggleImages?: (v: boolean) => void;
  imageLabel?: string;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function reset() {
    setDraggingId(null);
    setOverId(null);
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <Settings2 />
        Customize
      </PopoverTrigger>
      <PopoverContent align="end" className="p-2">
        <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
          Columns
        </div>
        <div className="space-y-0.5">
          {columns.map((c) => {
            const draggable = !c.locked;
            const isOver =
              draggable && overId === c.id && draggingId != null && draggingId !== c.id;
            return (
              <div
                key={c.id}
                draggable={draggable}
                onDragStart={
                  draggable
                    ? (e) => {
                        setDraggingId(c.id);
                        e.dataTransfer.effectAllowed = 'move';
                        // Some browsers require data to be set to start a drag.
                        e.dataTransfer.setData('text/plain', c.id);
                      }
                    : undefined
                }
                onDragOver={
                  draggable
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (overId !== c.id) setOverId(c.id);
                      }
                    : undefined
                }
                onDrop={
                  draggable
                    ? (e) => {
                        e.preventDefault();
                        if (draggingId && draggingId !== c.id) {
                          onReorder(draggingId, c.id);
                        }
                        reset();
                      }
                    : undefined
                }
                onDragEnd={reset}
                className={cn(
                  'flex items-center gap-2 rounded-md px-1.5 py-1 text-sm',
                  draggingId === c.id && 'opacity-50',
                  isOver && 'border-t-2 border-primary',
                )}
              >
                {draggable ? (
                  <GripVertical
                    className="size-3.5 shrink-0 cursor-grab text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <span className="size-3.5 shrink-0" aria-hidden />
                )}
                <Checkbox
                  checked={isVisible(c.id)}
                  disabled={c.locked}
                  onCheckedChange={() => onToggleColumn(c.id)}
                  aria-label={c.label}
                />
                <span
                  className={cn(
                    'flex-1 select-none',
                    c.locked ? 'text-muted-foreground' : 'cursor-pointer',
                  )}
                  onClick={c.locked ? undefined : () => onToggleColumn(c.id)}
                >
                  {c.label}
                </span>
                {c.locked ? (
                  <span className="text-[10px] text-muted-foreground">always</span>
                ) : null}
              </div>
            );
          })}
        </div>

        {onToggleImages ? (
          <>
            <div className="my-1 h-px bg-border" />
            <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
              Images
            </div>
            <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
              <span className="size-3.5 shrink-0" aria-hidden />
              <Checkbox
                checked={!!showImages}
                onCheckedChange={(v) => onToggleImages(v === true)}
                aria-label={imageLabel}
              />
              <span
                className="flex-1 cursor-pointer select-none"
                onClick={() => onToggleImages(!showImages)}
              >
                {imageLabel}
              </span>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
