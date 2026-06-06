'use client';

import { useState, useRef } from 'react';
import { Eye, EyeOff, GripVertical } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type WidgetInfo = {
  id: string;
  label: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widgets: WidgetInfo[];
  order: string[];
  hidden: Set<string>;
  defaultOrder: string[];
  onChange: (order: string[], hidden: string[]) => void;
};

export function CustomizePanel({
  open,
  onOpenChange,
  widgets,
  order,
  hidden,
  defaultOrder,
  onChange,
}: Props) {
  // Local state for the panel — initialized from props when opened
  const [localOrder, setLocalOrder] = useState<string[]>(order);
  const [localHidden, setLocalHidden] = useState<Set<string>>(new Set(hidden));

  // Sync local state when panel opens
  const prevOpen = useRef(open);
  if (open && !prevOpen.current) {
    setLocalOrder(order);
    setLocalHidden(new Set(hidden));
  }
  prevOpen.current = open;

  const dragIndex = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  function toggleWidget(id: string) {
    const next = new Set(localHidden);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setLocalHidden(next);
    onChange(localOrder, Array.from(next));
  }

  function handleDragStart(index: number) {
    dragIndex.current = index;
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    setDropTarget(index);
  }

  function handleDrop(targetIndex: number) {
    const from = dragIndex.current;
    if (from === null || from === targetIndex) {
      dragIndex.current = null;
      setDropTarget(null);
      return;
    }
    const next = [...localOrder];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    dragIndex.current = null;
    setDropTarget(null);
    setLocalOrder(next);
    onChange(next, Array.from(localHidden));
  }

  function handleDragEnd() {
    dragIndex.current = null;
    setDropTarget(null);
  }

  function reset() {
    setLocalOrder(defaultOrder);
    setLocalHidden(new Set());
    onChange(defaultOrder, []);
  }

  // Build a map for quick label lookup
  const widgetMap = new Map(widgets.map((w) => [w.id, w]));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-sm font-semibold">
            Customize Dashboard
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2">
          {localOrder.map((id, index) => {
            const widget = widgetMap.get(id);
            if (!widget) return null;
            const isHidden = localHidden.has(id);
            const isDropTarget = dropTarget === index;

            return (
              <div
                key={id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5 select-none cursor-grab active:cursor-grabbing',
                  'border-b border-transparent transition-colors',
                  isDropTarget && 'border-t-2 border-t-primary',
                  isHidden && 'opacity-50',
                )}
              >
                <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-sm">{widget.label}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => toggleWidget(id)}
                  title={isHidden ? 'Show widget' : 'Hide widget'}
                >
                  {isHidden ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="border-t px-6 py-3">
          <button
            onClick={reset}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Reset to defaults
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
