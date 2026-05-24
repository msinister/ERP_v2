'use client';

import { useEffect, useState } from 'react';

// =============================================================================
// Show/hide product-image columns across all line-item tables. State
// lives in localStorage so the preference persists per browser; the
// effect side-toggles a class on <html> that the CSS-conditional
// table cells respond to (no per-component prop drilling).
//
// Hydration-flicker note: the inline blocking script in
// src/app/layout.tsx reads localStorage BEFORE React hydration and
// applies the class to <html> immediately, so users with the column
// hidden don't see it flash visible on first paint. This hook then
// syncs the React state with what the script already wrote.
// =============================================================================

const STORAGE_KEY = 'showProductImages';
const HIDE_CLASS = 'hide-product-images';

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

export function useProductImageToggle(): {
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

// Constants exported so the inline blocking script + LinesTable
// className references stay in sync with the storage key.
export const PRODUCT_IMAGE_TOGGLE_STORAGE_KEY = STORAGE_KEY;
export const PRODUCT_IMAGE_TOGGLE_HIDE_CLASS = HIDE_CLASS;
