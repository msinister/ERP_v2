// =============================================================================
// Pluggable upload interface.
//
// Today: local-disk fallback (writes to public/uploads/, returns a
// relative URL that Next.js serves statically). Use during dev or when
// Spaces credentials aren't ready.
//
// Future: Spaces-backed implementation lives in spaces-uploader.ts (not
// yet built). To swap, change the default export of this file to the
// Spaces impl once SPACES_ENDPOINT / SPACES_BUCKET / SPACES_KEY /
// SPACES_SECRET are populated. Consumers (API routes, services) call
// `uploadImage(...)` — they don't know which backend is wired.
//
// IMPORTANT — the local-disk path writes under /public/uploads/ which
// is served from the Next.js project root. Files persist across builds
// (Next.js doesn't clear /public on rebuild) but DO NOT persist across
// deploys to ephemeral hosts (App Platform spins up fresh filesystems).
// This is acceptable for dev and pilot environments where the user
// runs Next.js locally. Production must swap to Spaces before launch.
// =============================================================================

export type UploadResult = {
  /** Public URL (relative or absolute) that an <img src> can resolve. */
  url: string;
  /** Original filename, for display + altText defaulting. */
  filename: string;
  /** Bytes written. */
  bytes: number;
  /** Detected content type. */
  contentType: string;
};

export type UploadInput = {
  /** Image bytes. */
  buffer: Buffer;
  /** Operator-supplied filename (used as the URL slug suffix). */
  filename: string;
  /** Browser-reported MIME type. */
  contentType: string;
  /** Subdirectory under the storage root (e.g., 'products', 'variants'). */
  prefix: string;
};

export interface Uploader {
  uploadImage(input: UploadInput): Promise<UploadResult>;
}

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export function isAcceptedImageMime(mime: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

// Default export — swap this line when Spaces lands.
import { localDiskUploader } from './local-disk-uploader';
export const uploader: Uploader = localDiskUploader;
