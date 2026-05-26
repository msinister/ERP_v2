'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

type Tag = { id: string; name: string };

// =============================================================================
// Inline operational-tag editor. Pills with an X to remove; an input that
// autocompletes the shared OrderTag dictionary. Enter or comma adds the typed
// value (creating the tag on the fly if it doesn't exist). All changes go
// through PATCH `${apiPath}` with `{ add, remove }`.
//
// Entity-agnostic: pass the entity's PATCH endpoint via `apiPath` (e.g.
// `/api/sales-orders/${soId}/tags`). The autocomplete source is always the
// shared `/api/order-tags` dictionary so a tag like "URGENT" is reusable
// across SO / PO / Bill / CM / RMA / WO / VC. Mirrors the product TagEditor.
// =============================================================================

export function OrderTagsEditor({
  apiPath,
  initialTags,
  placeholder = 'Add a tag…',
  emptyLabel = 'No tags',
}: {
  apiPath: string;
  initialTags: Tag[];
  placeholder?: string;
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  // Debounced autocomplete against the shared dictionary.
  useEffect(() => {
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/order-tags?q=${encodeURIComponent(input)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { tags: Tag[] };
        setSuggestions(data.tags);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => window.clearTimeout(handle);
  }, [input]);

  // Close the suggestion dropdown on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const existingNames = new Set(tags.map((t) => t.name.toLowerCase()));

  async function patch(body: { add?: string[]; remove?: string[] }) {
    setPending(true);
    try {
      const res = await fetch(apiPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error ?? `Failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { tags: Tag[] };
      setTags(data.tags);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  function addTag(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setInput('');
    setOpen(false);
    if (existingNames.has(trimmed.toLowerCase())) return; // already applied
    void patch({ add: [trimmed] });
  }

  function removeTag(name: string) {
    void patch({ remove: [name] });
  }

  const filteredSuggestions = suggestions.filter(
    (s) => !existingNames.has(s.name.toLowerCase()),
  );

  return (
    <div className="space-y-2" ref={boxRef}>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <span className="text-sm text-muted-foreground">{emptyLabel}</span>
        ) : (
          tags.map((t) => (
            <Badge key={t.id} variant="secondary" className="gap-1">
              {t.name}
              <button
                type="button"
                aria-label={`Remove ${t.name}`}
                disabled={pending}
                onClick={() => removeTag(t.name)}
                className="-mr-0.5 rounded-sm hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <div className="relative max-w-xs">
        <Input
          value={input}
          disabled={pending}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            const v = e.target.value;
            if (v.endsWith(',')) {
              addTag(v.slice(0, -1));
            } else {
              setInput(v);
              setOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag(input);
            }
          }}
          className="h-8"
        />
        {open && (filteredSuggestions.length > 0 || input.trim()) ? (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
            {filteredSuggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => addTag(s.name)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                {s.name}
              </button>
            ))}
            {input.trim() &&
            !suggestions.some(
              (s) => s.name.toLowerCase() === input.trim().toLowerCase(),
            ) ? (
              <button
                type="button"
                onClick={() => addTag(input)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                Create &ldquo;{input.trim()}&rdquo;
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
