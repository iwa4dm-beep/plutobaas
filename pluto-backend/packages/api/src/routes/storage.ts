import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import {
  ensureS3Bucket,
  putObject,
  getObjectStream,
  deleteObject,
  headObject,
  signedDownloadUrl,
  signedUploadUrl,
} from '../storage/s3.js';

// ---------- helpers ----------

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const SAFE_OBJ = /^[^\0\r\n]{1,1024}$/; // any UTF-8 except NUL/CR/LF, up to 1024 chars

type AuthCtx = { userId: string | null; role: 'anon' | 'authenticated' | 'service_role' };

async function authFrom(req: FastifyRequest): Promise<AuthCtx> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return { userId: null, role: 'anon' };
  try {
    const decoded = await (req as any).jwtVerify();
    const role = (decoded?.role as string) || 'authenticated';
    const safeRole = role === 'service_role' ? 'service_role' : 'authenticated';
    return { userId: decoded?.sub ?? null, role: safeRole };
  } catch {
    return { userId: null, role: 'anon' };
  }
}

/** Enforce bucket read/write policy. */
async function assertBucketAccess(
  cfg: Config,
  bucketId: string,
  ctx: AuthCtx,
  mode: 'read' | 'write',
): Promise<{ id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }> {
  const sql = getSql(cfg);
  const rows = await sql<any[]>`select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = ${bucketId}`;
  if (rows.length === 0) {
    const err: any = new Error('Bucket not found');
    err.statusCode = 404;
    throw err;
  }
  const bucket = rows[0];
  if (ctx.role === 'service_role') return bucket;
  if (mode === 'read' && bucket.public) return bucket;
  if (!ctx.userId) {
    const err: any = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  // authenticated user allowed by default; real per-object policies TBD
  return bucket;
}

// ---------- schemas ----------

const createBucketBody = z.object({
  id: z.string().regex(SAFE_ID),
  name: z.string().min(1).max(120).optional(),
  public: z.boolean().optional().default(false),
  file_size_limit: z.number().int().positive().optional(),
  allowed_mime_types: z.array(z.string().min(1)).optional(),
});

const updateBucketBody = z.object({
  public: z.boolean().optional(),
  file_size_limit: z.number().int().positive().nullable().optional(),
  allowed_mime_types: z.array(z.string()).nullable().optional(),
});

const signBody = z.object({
  expiresIn: z.number().int().min(1).max(60 * 60 * 24 * 7).optional(),
});

const signUploadBody = z.object({
  expiresIn: z.number().int().min(1).max(60 * 60 * 24).optional(),
  contentType: z.string().max(255).optional(),
});

// ---------- routes ----------

export async function storageRoutes(app: FastifyInstance, cfg: Config) {
  // Ensure the physical S3 bucket exists on boot (non-fatal on failure)
  try {
    await ensureS3Bucket(cfg);
  } catch (e: any) {
    app.log.warn({ err: e.message }, 'storage: could not verify S3 bucket');
  }

  // ---- Bucket management ----

  app.get('/storage/v1/bucket', async (req, reply) => {
    const ctx = await authFrom(req);
    const sql = getSql(cfg);
    const rows = ctx.role === 'service_role'
      ? await sql`select * from storage.buckets order by created_at desc`
      : await sql`select * from storage.buckets where public = true or owner_id = ${ctx.userId} order by created_at desc`;
    return reply.send(rows);
  });

  app.get<{ Params: { id: string } }>('/storage/v1/bucket/:id', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid bucket id' });
    const ctx = await authFrom(req);
    const bucket = await assertBucketAccess(cfg, req.params.id, ctx, 'read');
    return reply.send(bucket);
  });

  app.post('/storage/v1/bucket', async (req, reply) => {
    const ctx = await authFrom(req);
    if (!ctx.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const body = createBucketBody.parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into storage.buckets (id, name, owner_id, public, file_size_limit, allowed_mime_types)
      values (${body.id}, ${body.name ?? body.id}, ${ctx.userId}, ${body.public ?? false},
              ${body.file_size_limit ?? null}, ${body.allowed_mime_types ?? null})
      returning *`;
    return reply.code(201).send(row);
  });

  app.put<{ Params: { id: string } }>('/storage/v1/bucket/:id', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid bucket id' });
    const ctx = await authFrom(req);
    if (!ctx.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const body = updateBucketBody.parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      update storage.buckets set
        public = coalesce(${body.public ?? null}, public),
        file_size_limit = ${body.file_size_limit === undefined ? sql`file_size_limit` : body.file_size_limit},
        allowed_mime_types = ${body.allowed_mime_types === undefined ? sql`allowed_mime_types` : body.allowed_mime_types},
        updated_at = now()
      where id = ${req.params.id}
        and (${ctx.role === 'service_role'} or owner_id = ${ctx.userId})
      returning *`;
    if (!row) return reply.code(404).send({ error: 'Bucket not found or forbidden' });
    return reply.send(row);
  });

  app.delete<{ Params: { id: string } }>('/storage/v1/bucket/:id', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid bucket id' });
    const ctx = await authFrom(req);
    if (!ctx.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const sql = getSql(cfg);
    const rows = await sql<any[]>`
      delete from storage.buckets
      where id = ${req.params.id}
        and (${ctx.role === 'service_role'} or owner_id = ${ctx.userId})
      returning id`;
    if (rows.length === 0) return reply.code(404).send({ error: 'Bucket not found or forbidden' });
    return reply.send({ message: 'Deleted' });
  });

  // ---- Object list ----
  app.get<{ Params: { bucketId: string }; Querystring: { prefix?: string; limit?: string; offset?: string } }>(
    '/storage/v1/object/list/:bucketId',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      const ctx = await authFrom(req);
      await assertBucketAccess(cfg, req.params.bucketId, ctx, 'read');
      const prefix = req.query.prefix ?? '';
      const limit = Math.min(Number(req.query.limit ?? 100), 1000);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const sql = getSql(cfg);
      const rows = await sql`
        select name, size, mime_type, etag, metadata, created_at, updated_at
        from storage.objects
        where bucket_id = ${req.params.bucketId}
          and name like ${prefix + '%'}
        order by name asc
        limit ${limit} offset ${offset}`;
      return reply.send(rows);
    },
  );

  // ---- Upload (multipart or raw body) ----
  app.post<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      if (!SAFE_OBJ.test(name)) return reply.code(400).send({ error: 'invalid object name' });

      const ctx = await authFrom(req);
      const bucket = await assertBucketAccess(cfg, bucketId, ctx, 'write');

      let body: Buffer;
      let mime: string | undefined;

      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) {
        const file = await (req as any).file();
        if (!file) return reply.code(400).send({ error: 'no file uploaded' });
        body = await file.toBuffer();
        mime = file.mimetype;
      } else {
        body = req.body as Buffer;
        mime = typeof ct === 'string' ? ct.split(';')[0] : undefined;
      }

      if (bucket.file_size_limit && body.length > bucket.file_size_limit) {
        return reply.code(413).send({ error: 'file exceeds bucket size limit' });
      }
      if (bucket.allowed_mime_types && mime && !bucket.allowed_mime_types.includes(mime)) {
        return reply.code(415).send({ error: 'mime type not allowed' });
      }

      const put = await putObject(cfg, bucketId, name, body, mime);
      const sql = getSql(cfg);
      const [row] = await sql<any[]>`
        insert into storage.objects (bucket_id, name, owner_id, size, mime_type, etag)
        values (${bucketId}, ${name}, ${ctx.userId}, ${put.size}, ${mime ?? null}, ${put.etag ?? null})
        on conflict (bucket_id, name) do update set
          size = excluded.size,
          mime_type = excluded.mime_type,
          etag = excluded.etag,
          updated_at = now()
        returning *`;
      return reply.code(201).send({ Key: `${bucketId}/${name}`, ...row });
    },
  );

  // ---- Download (streaming) ----
  app.get<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/:bucketId/*',
    { exposeHeadRoute: false },
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });

      const ctx = await authFrom(req);
      await assertBucketAccess(cfg, bucketId, ctx, 'read');

      try {
        const obj = await getObjectStream(cfg, bucketId, name);
        reply.header('content-type', obj.ContentType || 'application/octet-stream');
        if (obj.ContentLength) reply.header('content-length', String(obj.ContentLength));
        if (obj.ETag) reply.header('etag', obj.ETag);
        return reply.send(obj.Body as Readable);
      } catch (e: any) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') {
          return reply.code(404).send({ error: 'Object not found' });
        }
        throw e;
      }
    },
  );

  // ---- Head (metadata) ----
  app.head<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send();
      const ctx = await authFrom(req);
      await assertBucketAccess(cfg, bucketId, ctx, 'read');
      try {
        const h = await headObject(cfg, bucketId, name);
        reply.header('content-type', h.ContentType || 'application/octet-stream');
        if (h.ContentLength) reply.header('content-length', String(h.ContentLength));
        if (h.ETag) reply.header('etag', h.ETag);
        return reply.send();
      } catch {
        return reply.code(404).send();
      }
    },
  );

  // ---- Delete ----
  app.delete<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      const ctx = await authFrom(req);
      if (!ctx.userId) return reply.code(401).send({ error: 'Unauthorized' });
      await assertBucketAccess(cfg, bucketId, ctx, 'write');
      const sql = getSql(cfg);
      await sql`delete from storage.objects where bucket_id = ${bucketId} and name = ${name}`;
      try {
        await deleteObject(cfg, bucketId, name);
      } catch (e: any) {
        app.log.warn({ err: e.message }, 'storage: s3 delete failed');
      }
      return reply.send({ message: 'Deleted' });
    },
  );

  // ---- Signed download URL ----
  app.post<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/sign/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      const ctx = await authFrom(req);
      await assertBucketAccess(cfg, bucketId, ctx, 'read');
      const body = signBody.parse(req.body ?? {});
      const url = await signedDownloadUrl(cfg, bucketId, name, body.expiresIn ?? 3600);
      return reply.send({ signedURL: url, url });
    },
  );

  // ---- Signed upload URL ----
  app.post<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/upload/sign/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      const ctx = await authFrom(req);
      if (!ctx.userId) return reply.code(401).send({ error: 'Unauthorized' });
      await assertBucketAccess(cfg, bucketId, ctx, 'write');
      const body = signUploadBody.parse(req.body ?? {});
      const url = await signedUploadUrl(cfg, bucketId, name, body.expiresIn ?? 3600, body.contentType);
      return reply.send({ signedURL: url, url });
    },
  );

  // ---- Public URL helper ----
  app.get<{ Params: { bucketId: string; '*': string } }>(
    '/storage/v1/object/public/:bucketId/*',
    async (req, reply) => {
      const bucketId = req.params.bucketId;
      const name = (req.params as any)['*'];
      if (!SAFE_ID.test(bucketId)) return reply.code(400).send({ error: 'invalid bucket id' });
      const sql = getSql(cfg);
      const [b] = await sql<any[]>`select public from storage.buckets where id = ${bucketId}`;
      if (!b) return reply.code(404).send({ error: 'Bucket not found' });
      if (!b.public) return reply.code(403).send({ error: 'Bucket is private' });
      try {
        const obj = await getObjectStream(cfg, bucketId, name);
        reply.header('content-type', obj.ContentType || 'application/octet-stream');
        if (obj.ContentLength) reply.header('content-length', String(obj.ContentLength));
        return reply.send(obj.Body as Readable);
      } catch {
        return reply.code(404).send({ error: 'Object not found' });
      }
    },
  );
}
