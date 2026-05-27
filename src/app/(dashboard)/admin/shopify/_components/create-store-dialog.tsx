'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// Minimal "create store" dialog — just enough to add a row. Operator fills
// in tokens, location id, flags, and routing rules on the detail page after
// creation. We POST to /api/admin/shopify/stores then route into the new
// store's detail page so the operator continues setup.

export function CreateStoreButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New store
      </Button>
      <CreateStoreDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function CreateStoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [storeUrl, setStoreUrl] = useState('');

  function reset() {
    setName('');
    setStoreUrl('');
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/shopify/stores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), storeUrl: storeUrl.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            issues?: Array<{ path?: Array<string | number>; message?: string }>;
          };
          const issueMsg = body.issues?.[0]?.message;
          toast.error(issueMsg ?? body.error ?? `Create failed (${res.status})`);
          return;
        }
        const created = (await res.json()) as { id: string };
        toast.success('Store created — finish setup on the detail page.');
        reset();
        onOpenChange(false);
        router.push(`/admin/shopify/${created.id}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <form onSubmit={onSubmit}>
          <AlertDialogHeader>
            <AlertDialogTitle>New Shopify store</AlertDialogTitle>
            <AlertDialogDescription>
              Two fields to get started; everything else (tokens, webhook
              secret, location id, sync flags, routing rules) goes on the
              detail page.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 py-2">
            <Field>
              <FieldLabel htmlFor="create-store-name">Display name</FieldLabel>
              <Input
                id="create-store-name"
                placeholder="Wholesale B2B"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="create-store-url">Store URL</FieldLabel>
              <Input
                id="create-store-url"
                placeholder="mystore.myshopify.com"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
                autoComplete="off"
                required
              />
              <p className="text-xs text-muted-foreground">
                The bare *.myshopify.com host. No https://, no path.
              </p>
            </Field>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create store'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
