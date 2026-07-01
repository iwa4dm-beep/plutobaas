import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHmac } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config.js";

export interface StorageDriver {
  put(bucket: string, key: string, body: Readable | Buffer, contentType: string): Promise<void>;
  get(bucket: string, key: string): Promise<Readable>;
  remove(bucket: string, key: string): Promise<void>;
  signedUrl(bucket: string, key: string, expiresIn: number, mode: "read" | "write"): Promise<string>;
}

class LocalDriver implements StorageDriver {
  private root = resolve(env.STORAGE_LOCAL_DIR);
  private path(bucket: string, key: string) {
    const p = join(this.root, bucket, key);
    if (!p.startsWith(this.root)) throw new Error("path_traversal");
    return p;
  }
  async put(bucket: string, key: string, body: Readable | Buffer, _ct: string) {
    const p = this.path(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await pipeline(Readable.from(body), createWriteStream(p));
    } else {
      await pipeline(body, createWriteStream(p));
    }
  }
  async get(bucket: string, key: string) {
    const p = this.path(bucket, key);
    if (!existsSync(p)) throw Object.assign(new Error("not_found"), { code: "ENOENT" });
    return createReadStream(p);
  }
  async remove(bucket: string, key: string) {
    await rm(this.path(bucket, key), { force: true });
  }
  async signedUrl(bucket: string, key: string, expiresIn: number, mode: "read" | "write") {
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const payload = `${mode}:${bucket}:${key}:${exp}`;
    const sig = createHmac("sha256", env.JWT_SECRET).update(payload).digest("hex");
    const q = new URLSearchParams({ exp: String(exp), sig, mode });
    return `/storage/v1/object/${bucket}/${encodeURI(key)}?${q}`;
  }
  verifyLocalSig(bucket: string, key: string, exp: number, sig: string, mode: "read" | "write") {
    if (Date.now() / 1000 > exp) return false;
    const expected = createHmac("sha256", env.JWT_SECRET).update(`${mode}:${bucket}:${key}:${exp}`).digest("hex");
    return expected === sig;
  }
  async statFile(bucket: string, key: string) {
    return stat(this.path(bucket, key));
  }
}

class S3Driver implements StorageDriver {
  private client: S3Client;
  constructor() {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
        : undefined,
      forcePathStyle: true,
    });
  }
  private k(bucket: string, key: string) { return `${bucket}/${key}`; }
  async put(bucket: string, key: string, body: Readable | Buffer, ContentType: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET!, Key: this.k(bucket, key), Body: body, ContentType,
    }));
  }
  async get(bucket: string, key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: this.k(bucket, key) }));
    return r.Body as Readable;
  }
  async remove(bucket: string, key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET!, Key: this.k(bucket, key) }));
  }
  async signedUrl(bucket: string, key: string, expiresIn: number, mode: "read" | "write") {
    const cmd = mode === "read"
      ? new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: this.k(bucket, key) })
      : new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: this.k(bucket, key) });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === "s3" ? new S3Driver() : new LocalDriver();

export const localDriver = storage instanceof LocalDriver ? storage : null;
