// Phase 15 · CORS admin endpoints — database-driven allow-list.
//
//   GET    /admin/v1/cors/origins             list all rows
//   POST   /admin/v1/cors/origins             add { origin, workspace_id?, description?, enabled? }
//   PATCH  /admin/v1/cors/origins/:id         toggle enabled / edit description
//   DELETE /admin/v1/cors/origins/:id         remove
//   POST   /admin/v1/cors/origins/reload      force cache refresh
//
// All mutations invalidate the in-memory cache so changes apply within
// milliseconds across the whole API — no server restart, no env edit.
//
// Auth: caller must be a superadmin OR present service_role JWT.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import { invalidateCorsCache, listCached, primeCorsCache } from '../cors/registry.js';

const originSchema = z
  .string()
  .min(4)
  .max(255)
  .regex(
    /^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i,
    'must be a bare origin like https://app.example.com (no path, no trailing slash)',
  );

async function requireAdmin(req: FastifyRequest, cfg: Config): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  if (decoded?.role === 'service_role') return;
  const userId = decoded?.sub;
  if (!userId) { const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e; }
  const sql = getSql(cfg);
  const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${userId}`;
  if (!u?.is_superadmin) { const e: any = new Error('Forbidden'); e.statusCode = 403; throw e; }
}

export async function corsRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/cors/origins', async (req) => {
    await requireAdmin(req, cfg);
    const sql = getSql(cfg);
    const rows = await sql`
      select id, workspace_id, origin, description, enabled, created_at
      from admin.cors_origins
      order by created_at desc
    `;
    return { items: rows, cached: listCached() };
  });

  app.post('/admin/v1/cors/origins', async (req, reply) => {
    await requireAdmin(req, cfg);
    const body = z.object({
      origin: originSchema,
      workspace_id: z.string().uuid().nullable().optional(),
      description: z.string().max(500).optional(),
      enabled: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'bad_request', issues: body.error.issues };
    }
    const sql = getSql(cfg);
    try {
      const [row] = await sql`
        insert into admin.cors_origins (origin, workspace_id, description, enabled)
        values (
          ${body.data.origin.toLowerCase()},
          ${body.data.workspace_id ?? null},
          ${body.data.description ?? null},
          ${body.data.enabled ?? true}
        )
        on conflict (workspace_id, origin) do update
          set enabled = excluded.enabled,
              description = coalesce(excluded.description, admin.cors_origins.description)
        returning id, workspace_id, origin, description, enabled, created_at
      `;
      invalidateCorsCache();
      return { item: row };
    } catch (e: any) {
      reply.code(409);
      return { error: 'insert_failed', detail: e.message };
    }
  });

  app.patch('/admin/v1/cors/origins/:id', async (req, reply) => {
    await requireAdmin(req, cfg);
    const id = z.string().uuid().safeParse((req.params as any).id);
    if (!id.success) { reply.code(400); return { error: 'bad_id' }; }
    const body = z.object({
      enabled: z.boolean().optional(),
      description: z.string().max(500).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) { reply.code(400); return { error: 'bad_request', issues: body.error.issues }; }
    const sql = getSql(cfg);
    const [row] = await sql`
      update admin.cors_origins set
        enabled     = coalesce(${body.data.enabled ?? null}, enabled),
        description = coalesce(${body.data.description ?? null}, description)
      where id = ${id.data}
      returning id, workspace_id, origin, description, enabled, created_at
    `;
    if (!row) { reply.code(404); return { error: 'not_found' }; }
    invalidateCorsCache();
    return { item: row };
  });

  app.delete('/admin/v1/cors/origins/:id', async (req, reply) => {
    await requireAdmin(req, cfg);
    const id = z.string().uuid().safeParse((req.params as any).id);
    if (!id.success) { reply.code(400); return { error: 'bad_id' }; }
    const sql = getSql(cfg);
    await sql`delete from admin.cors_origins where id = ${id.data}`;
    invalidateCorsCache();
    return { ok: true };
  });

  app.post('/admin/v1/cors/origins/reload', async (req) => {
    await requireAdmin(req, cfg);
    await primeCorsCache(cfg);
    return { ok: true, cached: listCached() };
  });
}
