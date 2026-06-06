'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { toast } from '@/lib/toast';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const SENSITIVE_KINDS = new Set(['EIN', 'SSN', 'DRIVERS_LICENSE']);

const FILE_KIND_OPTIONS = [
  { value: 'RESALE_PERMIT', label: 'Resale permit' },
  { value: 'BUSINESS_LICENSE', label: 'Business license' },
  { value: 'RESALE_CERT', label: 'Resale certificate' },
  { value: 'OTHER', label: 'Other' },
] as const;

const SENSITIVE_KIND_OPTIONS = [
  { value: 'EIN', label: 'EIN (Employer ID)' },
  { value: 'DRIVERS_LICENSE', label: "Driver's license" },
  { value: 'SSN', label: 'SSN' },
] as const;

const ALL_KIND_OPTIONS = [...FILE_KIND_OPTIONS, ...SENSITIVE_KIND_OPTIONS];

type DocKind =
  | 'RESALE_PERMIT'
  | 'BUSINESS_LICENSE'
  | 'RESALE_CERT'
  | 'OTHER'
  | 'EIN'
  | 'SSN'
  | 'DRIVERS_LICENSE';

export type DocRow = {
  id: string;
  kind: DocKind;
  fileName: string | null;
  storageKey: string | null;
  expiresOn: Date | null;
  notes: string | null;
};

type Props = {
  customerId: string;
  doc?: DocRow; // undefined = add/upload mode
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Errors = Partial<Record<string, string>>;

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ path?: Array<string | number>; message?: string }>;
    };
    if (body.issues?.length) {
      const issue = body.issues[0];
      const path = issue.path?.length ? issue.path.join('.') + ': ' : '';
      return `${path}${issue.message ?? 'validation error'}`;
    }
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function toDateInputValue(d: Date | null): string {
  if (!d) return '';
  // Use UTC date parts to avoid timezone-induced off-by-one
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// -------------------------------------------------------------------------
// Main dialog
// -------------------------------------------------------------------------

export function DocumentFormDialog({
  customerId,
  doc,
  open,
  onOpenChange,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = doc !== undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shared fields
  const [kind, setKind] = useState<DocKind>('RESALE_CERT');
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  // File-kind fields
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Sensitive-kind fields
  const [cleartextValue, setCleartextValue] = useState('');

  const effectiveKind = isEdit ? doc!.kind : kind;
  const isSensitive = SENSITIVE_KINDS.has(effectiveKind);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSelectedFile(null);
    setCleartextValue('');
    if (doc) {
      setKind(doc.kind);
      setExpiresOn(toDateInputValue(doc.expiresOn));
      setNotes(doc.notes ?? '');
    } else {
      setKind('RESALE_CERT');
      setExpiresOn('');
      setNotes('');
    }
  }, [open, doc]);

  function validate(): Errors {
    const e: Errors = {};
    if (!isSensitive) {
      // File kind
      if (!isEdit && !selectedFile) e.file = 'Please select a file to upload';
    } else {
      // Sensitive kind
      if (!isEdit && !cleartextValue.trim()) e.cleartextValue = 'Required';
      // On edit, cleartextValue is optional (blank = don't change the stored value)
    }
    return e;
  }

  function submit() {
    const e = validate();
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return;
    }
    setErrors({});

    startTransition(async () => {
      try {
        let res: Response;

        if (!isSensitive) {
          // File kind — multipart
          if (!isEdit) {
            // New document upload
            const form = new FormData();
            form.append('kind', kind);
            form.append('file', selectedFile!);
            if (expiresOn) form.append('expiresOn', expiresOn);
            if (notes.trim()) form.append('notes', notes.trim());
            res = await fetch(
              `/api/customers/${customerId}/documents/file-upload`,
              { method: 'POST', body: form },
            );
          } else {
            // Metadata-only edit (no file selected) or replace file
            if (selectedFile) {
              // Replace file
              const form = new FormData();
              form.append('file', selectedFile);
              if (expiresOn) form.append('expiresOn', expiresOn);
              if (notes.trim()) form.append('notes', notes.trim());
              res = await fetch(
                `/api/customers/${customerId}/documents/${doc!.id}/replace-file`,
                { method: 'POST', body: form },
              );
            } else {
              // Metadata patch only
              res = await fetch(
                `/api/customers/${customerId}/documents/${doc!.id}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    expiresOn: expiresOn || null,
                    notes: notes.trim() || null,
                  }),
                },
              );
            }
          }
        } else {
          // Sensitive kind — JSON
          if (!isEdit) {
            res = await fetch(`/api/customers/${customerId}/documents`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kind,
                cleartextValue: cleartextValue.trim(),
                expiresOn: expiresOn || undefined,
                notes: notes.trim() || undefined,
              }),
            });
          } else {
            const payload: Record<string, unknown> = {
              expiresOn: expiresOn || null,
              notes: notes.trim() || null,
            };
            // Only include cleartextValue if the user entered something new
            if (cleartextValue.trim()) {
              payload.cleartextValue = cleartextValue.trim();
            }
            res = await fetch(
              `/api/customers/${customerId}/documents/${doc!.id}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              },
            );
          }
        }

        if (!res.ok) {
          toast.error(await readApiError(res));
          return;
        }
        toast.success(isEdit ? 'Document updated' : 'Document uploaded');
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  const kindLabel = ALL_KIND_OPTIONS.find((o) => o.value === effectiveKind)?.label ?? effectiveKind;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEdit ? `Edit document — ${kindLabel}` : 'Upload document'}
          </AlertDialogTitle>
          {isEdit && isSensitive ? (
            <AlertDialogDescription>
              Leave the value field blank to keep the current stored value.
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>

        <div className="space-y-3">
          {/* Kind selector — only on add */}
          {!isEdit ? (
            <Field>
              <FieldLabel htmlFor="doc-kind">Document type</FieldLabel>
              <Select
                value={kind}
                onValueChange={(v) => setKind((v ?? 'RESALE_CERT') as DocKind)}
              >
                <SelectTrigger id="doc-kind" className="w-full">
                  <SelectValue>
                    {(v: string) =>
                      ALL_KIND_OPTIONS.find((o) => o.value === v)?.label ?? v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    File attachments
                  </div>
                  {FILE_KIND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                  <div className="my-1 -mx-1 h-px bg-border" />
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Sensitive values (encrypted)
                  </div>
                  {SENSITIVE_KIND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {/* File upload — file kinds */}
          {!isSensitive ? (
            <Field>
              <FieldLabel>
                {isEdit ? 'Replace file (optional)' : 'File'}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.doc,.docx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setSelectedFile(f);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-3.5" />
                  {selectedFile ? 'Change file' : 'Choose file'}
                </Button>
                {selectedFile ? (
                  <span className="truncate text-sm text-muted-foreground max-w-[180px]">
                    {selectedFile.name}
                  </span>
                ) : isEdit && doc!.fileName ? (
                  <span className="truncate text-sm text-muted-foreground max-w-[180px]">
                    Current: {doc!.fileName}
                  </span>
                ) : null}
              </div>
              <FieldError errors={[errors.file ? { message: errors.file } : undefined]} />
              <p className="text-xs text-muted-foreground">
                PDF, image, or Word document — max 20 MB.
              </p>
            </Field>
          ) : null}

          {/* Cleartext value — sensitive kinds */}
          {isSensitive ? (
            <Field>
              <FieldLabel htmlFor="doc-value">
                {effectiveKind === 'EIN'
                  ? 'EIN'
                  : effectiveKind === 'SSN'
                  ? 'SSN'
                  : "Driver's license number"}
              </FieldLabel>
              <Input
                id="doc-value"
                type="password"
                autoComplete="off"
                placeholder={isEdit ? 'Leave blank to keep current value' : 'Enter value'}
                value={cleartextValue}
                onChange={(e) => setCleartextValue(e.target.value)}
                aria-invalid={!!errors.cleartextValue}
              />
              <FieldError
                errors={[
                  errors.cleartextValue ? { message: errors.cleartextValue } : undefined,
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted at rest. Every view is audit-logged.
              </p>
            </Field>
          ) : null}

          {/* Expiration date */}
          <Field>
            <FieldLabel htmlFor="doc-expires">Expiration date</FieldLabel>
            <Input
              id="doc-expires"
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>

          {/* Notes */}
          <Field>
            <FieldLabel htmlFor="doc-notes">
              {effectiveKind === 'RESALE_CERT' || effectiveKind === 'RESALE_PERMIT'
                ? 'Certificate / permit number or notes'
                : 'Notes'}
            </FieldLabel>
            <Textarea
              id="doc-notes"
              rows={2}
              placeholder="optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={pending}>
            {pending
              ? isEdit
                ? 'Saving…'
                : 'Uploading…'
              : isEdit
              ? 'Save changes'
              : 'Upload'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
