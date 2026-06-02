// =============================================================================
// Pluggable upload interface.
//
// Backend is selected at startup:
//   SPACES_BUCKET set  → DigitalOcean Spaces (spaces-uploader.ts)
//   SPACES_BUCKET unset → local disk under public/uploads/ (dev only)
//
// Consumers call uploader.uploadImage(...) — they don't know which
// backend is wired. Local disk writes do NOT survive App Platform
// deploys (ephemeral filesystem); always set Spaces env vars on staging
// and production.
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

// Auto-select backend: Spaces when SPACES_BUCKET is set, local disk otherwise.
// Local disk works fine for development without any Spaces credentials.
import { localDiskUploader } from './local-disk-uploader';
import { spacesUploader } from './spaces-uploader';
export const uploader: Uploader = process.env.SPACES_BUCKET
  ? spacesUploader
  : localDiskUploader;
