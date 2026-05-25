'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Input } from '@/components/ui/input';

// Inline-editable bin location for one InventoryItem. Click the value to
// edit; Enter or blur saves, Escape cancels. Empty clears the bin.
export function BinCell({
  inventoryItemId,
  binLocation,
}: {
  inventoryItemId: string;
  binLocation: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(binLocation ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(binLocation ?? '');
  }, [binLocation]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function save() {
    const next = value.trim();
    const current = binLocation ?? '';
    if (next === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/inventory-items/${inventoryItemId}/bin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binLocation: next === '' ? null : next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? `Save failed (${res.status})`);
        setValue(current);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
      setValue(current);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        title="Click to edit bin location"
      >
        {binLocation ? (
          <span className="font-mono text-xs">{binLocation}</span>
        ) : (
          <span className="text-muted-foreground">— set bin —</span>
        )}
      </button>
    );
  }

  return (
    <Input
      ref={inputRef}
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void save();
        } else if (e.key === 'Escape') {
          setValue(binLocation ?? '');
          setEditing(false);
        }
      }}
      placeholder="e.g. A-12-3"
      className="h-7 w-32 font-mono text-xs"
    />
  );
}
