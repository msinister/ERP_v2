'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type Props = { customerId: string };

export function AddNoteForm({ customerId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  function submit() {
    const summary = text.trim();
    if (!summary) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/customers/${customerId}/activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? 'Failed to save note');
          return;
        }
        toast.success('Note saved');
        setText('');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          + Add note
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <Textarea
        rows={3}
        placeholder="Add a note…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setText('');
            setOpen(false);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={pending || !text.trim()}>
          {pending ? 'Saving…' : 'Save note'}
        </Button>
      </div>
    </div>
  );
}
