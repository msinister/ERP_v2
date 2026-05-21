import { useEffect, useRef } from 'react';

/**
 * Auto-append a blank line item when the LAST line's variant goes from
 * empty → filled. Drives the "fill the last line and the next blank
 * appears" UX on line-item forms (SO, PO, Bill, Credit Memo, add-lines)
 * so the operator never has to click "+ Add line".
 *
 * - `lastVariantId`: the current variant id of the LAST line ('' / null /
 *   undefined when blank). Derive it from RHF `watch('lines')` or the
 *   form's local draft state.
 * - `appendBlank`: appends exactly one blank line (e.g.
 *   `() => append(emptyLine())` or `() => setDrafts((d) => [...d, blank()])`).
 *
 * Behavior (matches the spec rules):
 *   - Skips the initial mount, so an edit form pre-loaded with filled
 *     lines doesn't gain a spurious trailing blank.
 *   - Fires only on an empty→filled transition of the last line, so
 *     editing the last line's SKU doesn't append, and a bulk "+ Add 10"
 *     button (which leaves the new last line blank) doesn't trigger it.
 *   - Appends at most one line per transition.
 */
export function useAutoAppendLine(
  lastVariantId: string | null | undefined,
  appendBlank: () => void,
): void {
  // Keep the latest appender without making it an effect dependency, so
  // the effect runs only when lastVariantId actually changes.
  const appendRef = useRef(appendBlank);
  appendRef.current = appendBlank;
  const seededRef = useRef(false);
  const prevRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!seededRef.current) {
      seededRef.current = true;
      prevRef.current = lastVariantId;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = lastVariantId;
    if (!prev && lastVariantId) appendRef.current();
  }, [lastVariantId]);
}
