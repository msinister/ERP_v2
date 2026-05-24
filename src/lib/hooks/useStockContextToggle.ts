'use client';

import { useEffect, useState } from 'react';

// =============================================================================
// Show/hide internal stock-context + cost-reference fields on staff-only
// line-item tables (SO detail, eventually PO detail). Mirrors
// useProductImageToggle: state lives in localStorage; the effect toggles
// a class on <html> that CSS-conditional cells respond to via the
// Tailwind arbitrary `[.hide-stock-context_&]:hidden` selector.
//
// These fields (QOH, Available, WAC, Last) are internal references only
// and must never appear on customer-facing documents — gating happens at
// the cell level, not in this hook.
//
// Hydration-flicker note: the inline blocking script in
// src/app/layout.tsx reads localStorage BEFORE React hydration and
// applies the class to <html> immediately so users with the rows hidden
// don't see them flash visible on first paint.
// =============================================================================

const STORAGE_KEY = 'showStockContext';
const HIDE_CLASS = 'hide-stock-context';

function readInitial(): boolean {
  if (typeof window === 'undefined') return true;
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === null) return true;
  return v !== 'false';
}

function applyClass(show: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(HIDE_CLASS, !show);
}

export function useStockContextToggle(): {
  show: boolean;
  toggle: () => void;
  set: (next: boolean) => void;
} {
  // Consistent default on the server AND the client's first render so
  // hydration matches (reading localStorage in the initializer is what
  // caused the SSR-vs-client mismatch). The persisted preference is read
  // after mount below; the inline blocking script in layout.tsx has already
  // applied the correct <html> class pre-hydration, so there's no content
  // flicker in the meantime.
  const [show, setShow] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);

  // Read the stored preference once, after the first client render.
  useEffect(() => {
    setShow(readInitial());
    setHydrated(true);
  }, []);

  // Sync the <html> class + localStorage with state — but only after we've
  // read the stored preference, so the first commit (default `true`) never
  // momentarily clobbers the class the blocking script already set.
  useEffect(() => {
    if (!hydrated) return;
    applyClass(show);
    window.localStorage.setItem(STORAGE_KEY, String(show));
  }, [show, hydrated]);

  return {
    show,
    toggle: () => setShow((s) => !s),
    set: setShow,
  };
}

export const STOCK_CONTEXT_TOGGLE_STORAGE_KEY = STORAGE_KEY;
export const STOCK_CONTEXT_TOGGLE_HIDE_CLASS = HIDE_CLASS;
