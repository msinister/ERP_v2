'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

// =============================================================================
// Reusable per-user table-view preferences (column visibility + image
// default), persisted via PUT /api/me/preferences under `prefKey`. Initial
// state comes from the server (passed in as `initial`) so SSR and the first
// client render match — no hydration mismatch. Changes persist immediately
// (fire-and-forget) after the first commit.
//
// Pair with <TableCustomizer/> for the UI; reuse on any list page by passing
// that page's column defs + a distinct prefKey.
// =============================================================================

export type CustomizableColumn = {
  id: string;
  label: string;
  defaultVisible: boolean;
  // Locked columns are always visible and can't be toggled off (e.g. SKU).
  locked?: boolean;
};

export type TableViewPrefValue = {
  columns?: Record<string, boolean>;
  showImages?: boolean;
};

export function useTablePreferences({
  prefKey,
  columns,
  initial,
}: {
  prefKey: string;
  columns: CustomizableColumn[];
  initial: TableViewPrefValue;
}): {
  isVisible: (id: string) => boolean;
  toggleColumn: (id: string) => void;
  showImages: boolean;
  setShowImages: (v: boolean) => void;
} {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(
    initial.columns ?? {},
  );
  const [showImages, setShowImagesState] = useState<boolean>(
    initial.showImages ?? false,
  );

  // Column metadata is stable for the component's life.
  const meta = useRef(
    new Map(columns.map((c) => [c.id, { def: c.defaultVisible, locked: !!c.locked }])),
  );

  function isVisible(id: string): boolean {
    const m = meta.current.get(id);
    if (!m) return false;
    if (m.locked) return true;
    return overrides[id] ?? m.def;
  }

  // Persist on change, skipping the initial mount (which just reflects the
  // server-provided values). Upsert is idempotent, so a dev StrictMode
  // double-invoke is harmless.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const value: TableViewPrefValue = { columns: overrides, showImages };
    void fetch('/api/me/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: prefKey, value }),
    })
      .then((res) => {
        if (!res.ok) toast.error('Could not save your view preferences.');
      })
      .catch(() => toast.error('Could not save your view preferences.'));
  }, [overrides, showImages, prefKey]);

  function toggleColumn(id: string): void {
    const m = meta.current.get(id);
    if (!m || m.locked) return;
    setOverrides((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? m.def),
    }));
  }

  return {
    isVisible,
    toggleColumn,
    showImages,
    setShowImages: setShowImagesState,
  };
}
