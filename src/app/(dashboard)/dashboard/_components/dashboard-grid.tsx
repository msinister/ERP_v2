'use client';

import { useState, type ReactNode } from 'react';
import React from 'react';
import { useRouter } from 'next/navigation';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CustomizePanel } from './customize-panel';

type WidgetInfo = {
  id: string;
  label: string;
  colSpan?: 2;
};

type Props = {
  widgets: WidgetInfo[];
  initialOrder: string[];
  initialHidden: string[];
  defaultOrder: string[];
  children: ReactNode;
};

export function DashboardGrid({
  widgets,
  initialOrder,
  initialHidden,
  defaultOrder,
  children,
}: Props) {
  const router = useRouter();
  const [order, setOrder] = useState<string[]>(initialOrder);
  const [hidden, setHidden] = useState<Set<string>>(new Set(initialHidden));
  const [panelOpen, setPanelOpen] = useState(false);

  // Build id → ReactNode map from children (each wrapped in a div with data-widget-id)
  const widgetMap = new Map<string, ReactNode>();
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child)) {
      const id = (child.props as Record<string, unknown>)['data-widget-id'] as
        | string
        | undefined;
      if (id) widgetMap.set(id, child);
    }
  });

  const widgetDefMap = new Map(widgets.map((w) => [w.id, w]));

  async function handleChange(newOrder: string[], newHidden: string[]) {
    setOrder(newOrder);
    setHidden(new Set(newHidden));
    try {
      await fetch('/api/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'dashboard.widgets',
          value: { order: newOrder, hidden: newHidden },
        }),
      });
    } catch {
      // Best-effort save — local state is already updated
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live snapshot of operations.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setPanelOpen(true)}
        >
          <Settings2 className="h-4 w-4" />
          Customize
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:grid-flow-row-dense">
        {order
          .filter((id) => !hidden.has(id) && widgetMap.has(id))
          .map((id) => {
            const def = widgetDefMap.get(id);
            return (
              <div
                key={id}
                className={def?.colSpan === 2 ? 'md:col-span-2' : undefined}
              >
                {widgetMap.get(id)}
              </div>
            );
          })}
      </div>

      <CustomizePanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        widgets={widgets}
        order={order}
        hidden={hidden}
        defaultOrder={defaultOrder}
        onChange={handleChange}
      />
    </div>
  );
}
