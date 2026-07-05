import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

let _client: S3Client | null = null;

export function getS3(cfg: Config): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      forcePathStyle: !!cfg.S3_ENDPOINT, // MinIO-style
      credentials:
        cfg.S3_ACCESS_KEY && cfg.S3_SECRET_KEY
          ? { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY }
          : undefined,
    });
  }
  return _client;
}

/** Ensure the underlying S3 bucket exists (idempotent). */
export async function ensureS3Bucket(cfg: Config): Promise<void> {
  const s3 = getS3(cfg);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: cfg.S3_BUCKET }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: cfg.S3_BUCKET }));
    } catch (e: any) {
      // ignore if already owned
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e?.name || e?.message))) {
        throw e;
      }
    }
  }
}

/** Key = <bucketId>/<objectName>  (single physical S3 bucket, logical namespacing) */
export function objectKey(bucketId: string, name: string): string {
  return `${bucketId}/${name.replace(/^\/+/, '')}`;
}

export async function putObject(
  cfg: Config,
  bucketId: string,
  name: string,
  body: Buffer,
  mime?: string,
): Promise<{ etag?: string; size: number }> {
  const s3 = getS3(cfg);
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: cfg.S3_BUCKET,
      Key: objectKey(bucketId, name),
      Body: body,
      ContentType: mime ?? 'application/octet-stream',
    }),
  );
  return { etag: res.ETag?.replace(/"/g, ''), size: body.length };
}

export async function getObjectStream(cfg: Config, bucketId: string, name: string) {
  const s3 = getS3(cfg);
  return s3.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: objectKey(bucketId, name) }));
}

export async function deleteObject(cfg: Config, bucketId: string, name: string) {
  const s3 = getS3(cfg);
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.S3_BUCKET, Key: objectKey(bucketId, name) }));
}

export async function headObject(cfg: Config, bucketId: string, name: string) {
  const s3 = getS3(cfg);
  return s3.send(new HeadObjectCommand({ Bucket: cfg.S3_BUCKET, Key: objectKey(bucketId, name) }));
}

export async function signedDownloadUrl(
  cfg: Config,
  bucketId: string,
  name: string,
  expiresIn = 3600,
): Promise<string> {
  const s3 = getS3(cfg);
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: objectKey(bucketId, name) }),
    { expiresIn },
  );
}

export async function signedUploadUrl(
  cfg: Config,
  bucketId: string,
  name: string,
  expiresIn = 3600,
  mime?: string,
): Promise<string> {
  const s3 = getS3(cfg);
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: cfg.S3_BUCKET,
      Key: objectKey(bucketId, name),
      ContentType: mime,
    }),
    { expiresIn },
  );
}
