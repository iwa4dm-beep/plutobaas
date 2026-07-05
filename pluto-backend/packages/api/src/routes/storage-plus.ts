// Storage v2: per-bucket role policies, resumable uploads, signed image
// transform URLs. Wraps existing storage backend; does not replace it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, randomBytes } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const policyBody = z.object({
  project_id: z.string().uuid(),
  bucket: z.string().min(1),
  role: z.enum(['anon', 'authenticated', 'service_role']),
  perms: z.array(z.enum(['read', 'write', 'delete', 'list'])).min(1),
  path_prefix: z.string().max(512).default(''),
});

const initUploadBody = z.object({
  project_id: z.string().uuid(),
  bucket: z.string().min(1),
  object_key: z.string().min(1).max(1024),
  size: z.number().int().min(1).max(50 * 1024 * 1024 * 1024), // up to 50GB
  content_type: z.string().optional(),
  metadata: z.record(z.string()).default({}),
});

const partBody = z.object({
  upload_id: z.string().min(1),
  part_number: z.number().int().min(1).max(10_000),
  size: z.number().int().min(1),
  etag: z.string().min(1),
});

const transformBody = z.object({
  project_id: z.string().uuid(),
  bucket: z.string().min(1),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('cover'),
  format: z.enum(['auto', 'jpeg', 'webp', 'avif', 'png']).default('auto'),
  quality: z.number().int().min(1).max(100).default(80),
});

export async function storagePlusRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Bucket policies ----------
  app.get('/storage/v1/policies', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), bucket: z.string().optional() }).parse(req.query);
    if (q.bucket) {
      return getSql(cfg)`select * from admin.bucket_policies where project_id = ${q.project_id} and bucket = ${q.bucket}`;
    }
    return getSql(cfg)`select * from admin.bucket_policies where project_id = ${q.project_id} order by bucket, role`;
  });

  app.post('/storage/v1/policies', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = policyBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.bucket_policies (project_id, bucket, role, perms, path_prefix)
      values (${body.project_id}, ${body.bucket}, ${body.role}, ${body.perms as any}, ${body.path_prefix})
      on conflict (project_id, bucket, role, path_prefix)
      do update set perms = excluded.perms
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.policy.upsert', target: `${body.bucket}:${body.role}`, detail: body });
    reply.code(201).send(row);
  });

  app.delete('/storage/v1/policies/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.bucket_policies where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.policy.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Resumable uploads (metadata-only orchestration) ----------
  app.post('/storage/v1/resumable/init', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = initUploadBody.parse(req.body);
    const uploadId = 'rup_' + randomBytes(12).toString('base64url');
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.resumable_uploads
        (project_id, bucket, object_key, upload_id, size, content_type, metadata, created_by)
      values (${body.project_id}, ${body.bucket}, ${body.object_key}, ${uploadId},
              ${body.size}, ${body.content_type ?? null}, ${body.metadata as any}, ${actor.userId})
      returning id, upload_id, size, received, status`;
    reply.code(201).send({ ...row, part_size: 5 * 1024 * 1024 });
  });

  app.get('/storage/v1/resumable/:uploadId', async (req, reply) => {
    await requireAuth(req, cfg);
    const { uploadId } = req.params as any;
    const [row] = await getSql(cfg)<any[]>`select * from admin.resumable_uploads where upload_id = ${uploadId}`;
    if (!row) { reply.code(404).send({ error: 'not_found' }); return; }
    return row;
  });

  app.post('/storage/v1/resumable/part', async (req, reply) => {
    await requireAuth(req, cfg);
    const body = partBody.parse(req.body);
    const sql = getSql(cfg);
    const [existing] = await sql<any[]>`select parts, received, status from admin.resumable_uploads where upload_id = ${body.upload_id}`;
    if (!existing) { reply.code(404).send({ error: 'not_found' }); return; }
    if (existing.status !== 'in_progress') { reply.code(409).send({ error: 'not_in_progress' }); return; }
    const parts: any[] = Array.isArray(existing.parts) ? existing.parts : [];
    const filtered = parts.filter((p) => p.part !== body.part_number);
    filtered.push({ part: body.part_number, etag: body.etag, size: body.size });
    const received = filtered.reduce((s, p) => s + Number(p.size || 0), 0);
    await sql`update admin.resumable_uploads
              set parts = ${filtered as any}, received = ${received}, updated_at = now()
              where upload_id = ${body.upload_id}`;
    return { received, parts: filtered.length };
  });

  app.post('/storage/v1/resumable/complete', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { upload_id } = z.object({ upload_id: z.string() }).parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`update admin.resumable_uploads set status = 'completed', updated_at = now() where upload_id = ${upload_id} returning *`;
    if (!row) { reply.code(404).send({ error: 'not_found' }); return; }
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.resumable.complete', target: row.object_key, detail: { size: row.size } });
    return row;
  });

  app.post('/storage/v1/resumable/abort', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { upload_id } = z.object({ upload_id: z.string() }).parse(req.body);
    await getSql(cfg)`update admin.resumable_uploads set status = 'aborted', updated_at = now() where upload_id = ${upload_id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.resumable.abort', target: upload_id });
    reply.code(204).send();
  });

  // ---------- Image transforms (named presets + signed URLs) ----------
  app.get('/storage/v1/transforms', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), bucket: z.string().optional() }).parse(req.query);
    if (q.bucket) return getSql(cfg)`select * from admin.image_transforms where project_id = ${q.project_id} and bucket = ${q.bucket}`;
    return getSql(cfg)`select * from admin.image_transforms where project_id = ${q.project_id} order by bucket, name`;
  });

  app.post('/storage/v1/transforms', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = transformBody.parse(req.body);
    const spec = { width: body.width, height: body.height, fit: body.fit, format: body.format, quality: body.quality };
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.image_transforms (project_id, bucket, name, spec)
      values (${body.project_id}, ${body.bucket}, ${body.name}, ${spec as any})
      on conflict (project_id, bucket, name) do update set spec = excluded.spec
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.transform.upsert', target: `${body.bucket}:${body.name}`, detail: spec });
    reply.code(201).send(row);
  });

  app.delete('/storage/v1/transforms/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.image_transforms where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'storage.transform.delete', target: id });
    reply.code(204).send();
  });

  app.post('/storage/v1/transforms/sign', async (req, reply) => {
    await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      bucket: z.string(),
      object_key: z.string(),
      transform: z.string(),
      ttl_seconds: z.number().int().min(30).max(60 * 60 * 24 * 7).default(3600),
    }).parse(req.body);
    const sql = getSql(cfg);
    const [t] = await sql<any[]>`select spec from admin.image_transforms where project_id = ${body.project_id} and bucket = ${body.bucket} and name = ${body.transform}`;
    if (!t) { reply.code(404).send({ error: 'transform_not_found' }); return; }
    const exp = Math.floor(Date.now() / 1000) + body.ttl_seconds;
    const base = `${body.bucket}/${body.object_key}?t=${body.transform}&exp=${exp}`;
    const sig = createHmac('sha256', cfg.PLUTO_JWT_SECRET).update(base).digest('base64url');
    const url = `/storage/v1/render/${base}&sig=${sig}`;
    return { url, expires_at: new Date(exp * 1000).toISOString(), spec: t.spec };
  });
}
