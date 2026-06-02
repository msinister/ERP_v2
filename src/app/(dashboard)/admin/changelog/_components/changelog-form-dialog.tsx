'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff } from 'lucide-react';
import { marked } from 'marked';
import { ChangelogEntryType } from '@/generated/tenant';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { toast } from '@/lib/toast';

const schema = z.object({
  version: z.string().min(1, 'Required').max(20),
  title: z.string().min(1, 'Required').max(255),
  description: z.string().min(1, 'Required'),
  type: z.nativeEnum(ChangelogEntryType),
  publishedAt: z.string().optional(), // ISO local datetime string or empty
});

type FormValues = z.infer<typeof schema>;

export type EntryForEdit = {
  id: string;
  version: string;
  title: string;
  description: string;
  type: ChangelogEntryType;
  publishedAt: string | null;
};

const TYPE_LABELS: Record<ChangelogEntryType, string> = {
  FEATURE: 'Feature',
  IMPROVEMENT: 'Improvement',
  BUGFIX: 'Bug fix',
  SECURITY: 'Security',
};

function toLocalDatetimeValue(iso: string | null): string {
  if (!iso) return '';
  // Convert ISO to local datetime-local input format (YYYY-MM-DDTHH:mm)
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeValue(val: string): string | null {
  if (!val) return null;
  return new Date(val).toISOString();
}

export function ChangelogFormDialog({
  open,
  onClose,
  entry, // null = create mode
}: {
  open: boolean;
  onClose: () => void;
  entry: EntryForEdit | null;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      version: '',
      title: '',
      description: '',
      type: ChangelogEntryType.FEATURE,
      publishedAt: '',
    },
  });

  // Reset form when dialog opens / entry changes
  useEffect(() => {
    if (!open) return;
    form.reset({
      version: entry?.version ?? '',
      title: entry?.title ?? '',
      description: entry?.description ?? '',
      type: entry?.type ?? ChangelogEntryType.FEATURE,
      publishedAt: entry ? toLocalDatetimeValue(entry.publishedAt) : toLocalDatetimeValue(new Date().toISOString()),
    });
    setPreview(false);
  }, [open, entry, form]);

  const descriptionValue = form.watch('description');

  useEffect(() => {
    if (!preview) return;
    setPreviewHtml(marked.parse(descriptionValue || '') as string);
  }, [preview, descriptionValue]);

  async function onSubmit(data: FormValues) {
    const body = {
      version: data.version,
      title: data.title,
      description: data.description,
      type: data.type,
      publishedAt: fromLocalDatetimeValue(data.publishedAt ?? ''),
    };

    const url = entry ? `/api/admin/changelog/${entry.id}` : '/api/admin/changelog';
    const method = entry ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err?.issues?.[0]?.message ?? 'Failed to save entry');
      return;
    }

    toast.success(entry ? 'Entry updated' : 'Entry created');
    onClose();
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit entry' : 'New changelog entry'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel>Version</FieldLabel>
              <Input {...form.register('version')} placeholder="2.0.1" />
              <FieldError>{form.formState.errors.version?.message}</FieldError>
            </Field>

            <Field>
              <FieldLabel>Type</FieldLabel>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(TYPE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel>Title</FieldLabel>
            <Input {...form.register('title')} placeholder="Short title for this release" />
            <FieldError>{form.formState.errors.title?.message}</FieldError>
          </Field>

          <Field>
            <FieldLabel>Publish date</FieldLabel>
            <Input
              type="datetime-local"
              {...form.register('publishedAt')}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank or set to a future date to keep as draft.
            </p>
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel>Description (Markdown)</FieldLabel>
              <button
                type="button"
                onClick={() => setPreview((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {preview ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                {preview ? 'Edit' : 'Preview'}
              </button>
            </div>
            {preview ? (
              <div
                className="prose prose-sm min-h-32 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <Textarea
                {...form.register('description')}
                rows={8}
                placeholder="Describe what changed. Markdown supported."
                className="font-mono text-sm"
              />
            )}
            <FieldError>{form.formState.errors.description?.message}</FieldError>
          </Field>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? 'Saving…'
                : entry
                  ? 'Save changes'
                  : 'Create entry'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
