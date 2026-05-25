import { toast as base, type ExternalToast } from 'sonner';
import type { ReactNode } from 'react';

// =============================================================================
// Toast policy — centralized so every call site gets consistent durations.
//
// Errors linger long enough to actually read (and carry a close button so
// they can be dismissed early); success/info clear quickly so they don't
// pile up. Any explicit per-call `duration` still wins because the caller's
// options spread LAST.
//
// Sonner v2 has no per-type duration on <Toaster> — the only global lever
// is a single `duration` for everything — so we wrap the `toast` API here
// and inject the right default per type. Import `toast` from '@/lib/toast'
// (NOT from 'sonner') everywhere in the app so this policy applies.
// =============================================================================

export const TOAST_DURATIONS = {
  // Errors: well past the "5–6s, readable" bar, plus a close button.
  error: 8000,
  warning: 6000,
  success: 3000,
  info: 3000,
} as const;

type Title = ReactNode | (() => ReactNode);

function withDefaults(
  fn: (message: Title, data?: ExternalToast) => string | number,
  defaults: ExternalToast,
) {
  // Caller-supplied options win — defaults first, `data` spread last.
  return (message: Title, data?: ExternalToast) =>
    fn(message, { ...defaults, ...data });
}

export const toast = Object.assign(
  // Bare toast() / toast.message() keep sonner's global default.
  (message: Title, data?: ExternalToast) => base(message, data),
  base, // carry over message/promise/loading/custom/dismiss/getToasts/etc.
  {
    error: withDefaults(base.error, {
      duration: TOAST_DURATIONS.error,
      closeButton: true,
    }),
    warning: withDefaults(base.warning, { duration: TOAST_DURATIONS.warning }),
    success: withDefaults(base.success, { duration: TOAST_DURATIONS.success }),
    info: withDefaults(base.info, { duration: TOAST_DURATIONS.info }),
  },
) as typeof base;
