import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Uploader, UploadInput, UploadResult } from './uploader';

// Local-disk uploader. Writes to <repo>/public/uploads/<prefix>/<rand>-<safe-name>
// and returns the relative URL /uploads/<prefix>/<rand>-<safe-name>.
// Next.js serves /public/* statically without any further wiring.
//
// File name shape: <16 random hex>-<sanitized original>.<ext>
// Random prefix prevents collisions when two operators upload the
// same filename simultaneously. Sanitization strips path separators
// and non-[\w.-] characters so a hostile filename can't escape the
// prefix directory.
const PUBLIC_UPLOADS_ROOT = join(process.cwd(), 'public', 'uploads');

function sanitizeFilename(raw: string): string {
  const ext = extname(raw).toLowerCase().replace(/[^.\w-]/g, '');
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^\w.-]/g, '_')
    .slice(0, 80); // cap base name length so URLs stay sane
  return `${base || 'image'}${ext || ''}`;
}

export const localDiskUploader: Uploader = {
  async uploadImage(input: UploadInput): Promise<UploadResult> {
    const dir = join(PUBLIC_UPLOADS_ROOT, input.prefix);
    await mkdir(dir, { recursive: true });
    const rand = randomBytes(8).toString('hex');
    const safe = sanitizeFilename(input.filename);
    const finalName = `${rand}-${safe}`;
    const absPath = join(dir, finalName);
    await writeFile(absPath, input.buffer);
    // Forward-slashes in the URL regardless of OS path separators —
    // Next.js serves /uploads/<prefix>/<name> on any platform.
    const url = `/uploads/${input.prefix}/${finalName}`;
    return {
      url,
      filename: input.filename,
      bytes: input.buffer.byteLength,
      contentType: input.contentType,
    };
  },
};
