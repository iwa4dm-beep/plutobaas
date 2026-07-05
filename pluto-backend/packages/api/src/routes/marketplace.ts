// Marketplace & Extensions: registry, install/uninstall lifecycle, webhook-plugins, starters.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

export async function marketplaceRoutes(app: FastifyInstance, cfg: Config) {
  const sql = getSql(cfg);

  // ---------- Registry (public listing) ----------
  app.get('/admin/v1/marketplace/extensions', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ category: z.string().optional(), q: z.string().optional() }).parse(req.query);
    return sql`
      select * from admin.marketplace_extensions
      where is_published = true
        ${q.category ? sql`and category = ${q.category}` : sql``}
        ${q.q ? sql`and (name ilike ${'%' + q.q + '%'} or description ilike ${'%' + q.q + '%'})` : sql``}
      order by is_official desc, install_count desc, name`;
  });

  app.get('/admin/v1/marketplace/extensions/:slug', async (req) => {
    await requireAuth(req, cfg);
    const { slug } = req.params as any;
    const [row] = await sql<any[]>`select * from admin.marketplace_extensions where slug = ${slug}`;
    if (!row) throw new Error('not found');
    return row;
  });

  app.post('/admin/v1/marketplace/extensions', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      slug: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.enum(['plugin','template','starter','webhook']).default('plugin'),
      author: z.string().optional(),
      version: z.string().default('0.1.0'),
      manifest: z.record(z.any()).default({}),
    }).parse(req.body);
    const [row] = await sql<any[]>`
      insert into admin.marketplace_extensions (slug, name, description, category, author, version, manifest)
      values (${body.slug}, ${body.name}, ${body.description ?? null}, ${body.category}, ${body.author ?? null}, ${body.version}, ${body.manifest})
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'marketplace.publish', target: body.slug });
    reply.code(201).send(row);
  });

  // ---------- Install lifecycle ----------
  app.get('/admin/v1/marketplace/installed', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return sql`
      select pe.*, e.slug, e.name, e.category, e.description, e.author, e.manifest as latest_manifest
      from admin.project_extensions pe
      join admin.marketplace_extensions e on e.id = pe.extension_id
      where pe.project_id = ${q.project_id}
      order by pe.installed_at desc`;
  });

  app.post('/admin/v1/marketplace/install', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      slug: z.string(),
      config: z.record(z.any()).default({}),
    }).parse(req.body);
    const [ext] = await sql<any[]>`select * from admin.marketplace_extensions where slug = ${body.slug} and is_published = true`;
    if (!ext) throw new Error('extension not found');
    const [inst] = await sql<any[]>`
      insert into admin.project_extensions (project_id, extension_id, version, config, installed_by)
      values (${body.project_id}, ${ext.id}, ${ext.version}, ${body.config}, ${actor.userId})
      on conflict (project_id, extension_id) do update set
        status = 'active', version = excluded.version, config = excluded.config, updated_at = now()
      returning *`;
    await sql`update admin.marketplace_extensions set install_count = install_count + 1 where id = ${ext.id}`;
    await sql`insert into admin.extension_events (project_extension_id, event, payload) values (${inst.id}, 'installed', ${{ version: ext.version }})`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'marketplace.install', target: body.slug, detail: { project_id: body.project_id } });
    reply.code(201).send({ ...inst, slug: ext.slug, name: ext.name, category: ext.category });
  });

  app.patch('/admin/v1/marketplace/installed/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ status: z.enum(['active','disabled']).optional(), config: z.record(z.any()).optional() }).parse(req.body);
    const [row] = await sql<any[]>`
      update admin.project_extensions set
        status = coalesce(${body.status ?? null}, status),
        config = coalesce(${body.config ?? null}::jsonb, config),
        updated_at = now()
      where id = ${id} returning *`;
    await sql`insert into admin.extension_events (project_extension_id, event, payload) values (${id}, 'updated', ${body})`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'marketplace.update', target: id, detail: body });
    return row;
  });

  app.delete('/admin/v1/marketplace/installed/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await sql`update admin.project_extensions set status = 'uninstalled', updated_at = now() where id = ${id}`;
    await sql`insert into admin.extension_events (project_extension_id, event, payload) values (${id}, 'uninstalled', '{}'::jsonb)`;
    await sql`delete from admin.project_extensions where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'marketplace.uninstall', target: id });
    reply.code(204).send();
  });

  // ---------- Webhook-plugin dispatch ----------
  app.post('/admin/v1/marketplace/dispatch', async (req) => {
    await requireAuth(req, cfg);
    const body = z.object({ project_id: z.string().uuid(), event: z.string(), payload: z.record(z.any()).default({}) }).parse(req.body);
    const hooks = await sql<any[]>`
      select pe.*, e.manifest, e.slug
      from admin.project_extensions pe
      join admin.marketplace_extensions e on e.id = pe.extension_id
      where pe.project_id = ${body.project_id} and pe.status = 'active' and e.category = 'webhook'`;
    let fired = 0;
    for (const h of hooks) {
      const patterns: string[] = h.manifest?.events ?? [];
      const match = patterns.some((p) => p === body.event || (p.endsWith('.*') && body.event.startsWith(p.slice(0, -1))));
      if (!match) continue;
      const url = (h.config as any)?.webhook_url;
      if (!url) continue;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pluto-event': body.event, 'x-pluto-extension': h.slug },
          body: JSON.stringify({ event: body.event, payload: body.payload, at: new Date().toISOString() }),
        });
        await sql`insert into admin.extension_events (project_extension_id, event, payload, status) values (${h.id}, ${body.event}, ${body.payload}, ${res.ok ? 'ok' : 'error_' + res.status})`;
        fired++;
      } catch (e: any) {
        await sql`insert into admin.extension_events (project_extension_id, event, payload, status) values (${h.id}, ${body.event}, ${body.payload}, ${'error_' + (e.message ?? 'unknown').slice(0, 40)})`;
      }
    }
    return { fired, hooks: hooks.length };
  });

  app.get('/admin/v1/marketplace/events', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_extension_id: z.string().uuid(), limit: z.coerce.number().int().max(500).default(100) }).parse(req.query);
    return sql`select * from admin.extension_events where project_extension_id = ${q.project_extension_id} order by at desc limit ${q.limit}`;
  });
}
