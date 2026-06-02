import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Uploader, UploadInput, UploadResult } from './uploader';

// DigitalOcean Spaces uploader. Spaces is S3-compatible; we use the AWS SDK
// pointed at the DO endpoint.
//
// Required env vars:
//   SPACES_ENDPOINT  — e.g. https://nyc3.digitaloceanspaces.com
//   SPACES_BUCKET    — bucket name
//   SPACES_KEY       — access key id
//   SPACES_SECRET    — secret access key
//
// Optional:
//   SPACES_CDN_ENDPOINT — CDN origin, e.g. https://mybucket.nyc3.cdn.digitaloceanspaces.com
//                         When set, public URLs are ${SPACES_CDN_ENDPOINT}/${key}.
//                         When absent, URLs are ${SPACES_ENDPOINT}/${SPACES_BUCKET}/${key}.

function getConfig() {
  const endpoint = process.env.SPACES_ENDPOINT;
  const bucket = process.env.SPACES_BUCKET;
  const key = process.env.SPACES_KEY;
  const secret = process.env.SPACES_SECRET;
  if (!endpoint || !bucket || !key || !secret) {
    throw new Error(
      'Spaces uploader requires SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET',
    );
  }
  const cdnEndpoint = process.env.SPACES_CDN_ENDPOINT ?? null;
  return { endpoint, bucket, key, secret, cdnEndpoint };
}

function sanitizeFilename(raw: string): string {
  const ext = extname(raw).toLowerCase().replace(/[^.\w-]/g, '');
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^\w.-]/g, '_')
    .slice(0, 80);
  return `${base || 'image'}${ext || ''}`;
}

export const spacesUploader: Uploader = {
  async uploadImage(input: UploadInput): Promise<UploadResult> {
    const { endpoint, bucket, key: accessKey, secret, cdnEndpoint } = getConfig();

    const client = new S3Client({
      endpoint,
      region: 'us-east-1', // required by SDK; DO ignores it
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
      forcePathStyle: false, // DO Spaces uses virtual-hosted style
    });

    const rand = randomBytes(8).toString('hex');
    const safe = sanitizeFilename(input.filename);
    const objectKey = `${input.prefix}/${rand}-${safe}`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: input.buffer,
        ContentType: input.contentType,
        ACL: 'public-read',
      }),
    );

    const url = cdnEndpoint
      ? `${cdnEndpoint}/${objectKey}`
      : `${endpoint}/${bucket}/${objectKey}`;

    return {
      url,
      filename: input.filename,
      bytes: input.buffer.byteLength,
      contentType: input.contentType,
    };
  },
};
