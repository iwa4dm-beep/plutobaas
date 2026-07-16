import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit, timed } from '../audit/logger.js';

const createBody = z.object({
  project_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  up_sql: z.string().min(1),
  down_sql: z.string().min(0).default(''),
});

const listQ = z.object({
  project_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'applied', 'rolled_back']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

async function assertRole(cfg: Config, projectId: string | null | undefined, actor: any) {
  if (!projectId) {
    if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      const e: any = new Error('Superadmin required for global migrations'); e.statusCode = 403; throw e;
    }
    return;
  }
  await requireProjectRole(cfg, projectId, actor, ['owner', 'admin']);
}

// Resolve the on-disk migrations directory (../../../migrations from this
// compiled file at dist/routes/migrations.js). Used by /migrations/history
// to compute checksums for files that back the applied ledger rows.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const MIG_DIR = resolve(dirname(__filename), '../../../../migrations');

async function loadFileChecksums(): Promise<Map<string, { checksum: string; bytes: number }>> {
  const out = new Map<string, { checksum: string; bytes: number }>();
  try {
    const entries = (await readdir(MIG_DIR)).filter((f) => f.endsWith('.sql'));
    await Promise.all(entries.map(async (f) => {
      const buf = await readFile(join(MIG_DIR, f));
      out.set(f, { checksum: 'sha256:' + createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
    }));
  } catch { /* directory missing in some test builds — endpoint still returns ledger */ }
  return out;
}

function parseVersion(name: string): string | null {
  const m = name.match(/^(\d{4}[a-z0-9_]*)/i);
  return m ? m[1] : null;
}

async function ensureWorkspaceOwnerColumns(sql: any) {
  await sql.unsafe(`
    create schema if not exists admin;

    create table if not exists admin.workspaces (
      id           uuid primary key default gen_random_uuid(),
      slug         text unique not null check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
      name         text not null,
      owner_id     uuid references auth.users(id) on delete set null,
      archived_at  timestamptz,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    );

    create table if not exists admin.workspace_members (
      workspace_id uuid not null references admin.workspaces(id) on delete cascade,
      user_id      uuid not null references auth.users(id)      on delete cascade,
      role         text not null check (role in ('owner','admin','developer','viewer')),
      created_at   timestamptz not null default now(),
      primary key (workspace_id, user_id)
    );

    alter table if exists admin.projects
      add column if not exists owner_id uuid references auth.users(id) on delete set null,
      add column if not exists created_at timestamptz default now();

    alter table if exists admin.workspaces
      add column if not exists owner_id uuid references auth.users(id) on delete set null,
      add column if not exists archived_at timestamptz,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now();

    create index if not exists workspaces_owner_idx on admin.workspaces(owner_id);
  `);
}

export async function migrationsRoutes(app: FastifyInstance, cfg: Config) {
  // Full history of the low-level runner ledger (public._pluto_migrations).
  // Superadmin-only. Joins each ledger row with the on-disk file's checksum
  // + byte size so drift is trivially visible.
  app.get('/admin/v1/migrations/history', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      return reply.code(403).send({ error: 'forbidden', message: 'superadmin required' });
    }
    const sql = getSql(cfg);
    const ledger = await sql`
      select name, applied_at
        from public._pluto_migrations
       order by name asc`;
    const files = await loadFileChecksums();
    const seen = new Set<string>();
    const rows = ledger.map((r: any) => {
      seen.add(r.name);
      const f = files.get(r.name);
      return {
        name: r.name,
        version: parseVersion(r.name),
        applied_at: r.applied_at,
        checksum: f?.checksum ?? null,
        bytes: f?.bytes ?? null,
        file_present: !!f,
      };
    });
    // Files on disk not yet applied — surfaced so debugging is one call.
    const pending: any[] = [];
    for (const [name, f] of files) {
      if (seen.has(name)) continue;
      pending.push({
        name, version: parseVersion(name),
        applied_at: null, checksum: f.checksum, bytes: f.bytes,
        file_present: true,
      });
    }
    return reply.send({
      count: rows.length,
      pending_count: pending.length,
      migrations: rows,
      pending,
    });
  });

  app.get('/admin/v1/migrations', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const q = listQ.parse(req.query);
    const sql = getSql(cfg);
    let projectIdsForWorkspace: string[] | null = null;
    if (q.workspace_id) {
      const projectRows = await sql<any[]>`select id from admin.projects where workspace_id = ${q.workspace_id}`;
      projectIdsForWorkspace = projectRows.map((r: any) => r.id);
    }
    const rows = await sql`
      select id, project_id, version, name, checksum,
             applied_at, applied_by, rolled_back_at, rolled_back_by,
             created_by, created_at,
             case
               when rolled_back_at is not null then 'rolled_back'
               when applied_at is not null     then 'applied'
               else 'pending'
             end as status
        from admin.migrations
       where (${q.project_id ?? null}::uuid is null or project_id = ${q.project_id ?? null})
          and (${q.workspace_id ?? null}::uuid is null or project_id = any(${projectIdsForWorkspace ?? []}::uuid[]))
         and (
           ${actor.isSuperadmin || actor.role === 'service_role'}::boolean
           or project_id in (select project_id from admin.project_members where user_id = ${actor.userId})
         )
       order by coalesce(applied_at, created_at) desc
       limit ${q.limit}`;
    const filtered = q.status ? rows.filter((r: any) => r.status === q.status) : rows;
    return reply.send(filtered);
  });

  app.get<{ Params: { id: string } }>('/admin/v1/migrations/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.project_id) await requireProjectRole(cfg, row.project_id, actor, ['owner', 'admin', 'developer', 'viewer']);
    else if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send(row);
  });

  app.post('/admin/v1/migrations', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createBody.parse(req.body);
    const sql = getSql(cfg);
    let projectId = body.project_id ?? null;
    if (!projectId && body.workspace_id) {
      await ensureWorkspaceOwnerColumns(sql);
      const [project] = await sql<any[]>`
        select id from admin.projects
         where workspace_id = ${body.workspace_id}
         order by created_at asc nulls last, id asc
         limit 1`;
      projectId = project?.id ?? null;
    }
    await assertRole(cfg, projectId, actor);
    const version = BigInt(Date.now());
    const checksum = createHash('sha256').update(body.up_sql).digest('hex').slice(0, 32);
    const [row] = await sql<any[]>`
      insert into admin.migrations (project_id, version, name, up_sql, down_sql, checksum, created_by)
      values (${projectId}, ${version}, ${body.name}, ${body.up_sql}, ${body.down_sql}, ${checksum}, ${actor.userId})
      returning id, project_id, version, name, checksum, created_at`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: projectId,
      action: 'migration.create', resource_type: 'migration', resource_id: row.id,
      params: { name: body.name, version: String(row.version) }, result: 'ok',
    });
    return reply.code(201).send(row);
  });

  app.post<{ Params: { id: string } }>('/admin/v1/migrations/:id/apply', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (m.applied_at && !m.rolled_back_at) return reply.code(409).send({ error: 'already applied' });
    await assertRole(cfg, m.project_id, actor);
    try {
      await ensureWorkspaceOwnerColumns(sql);
      const t = await timed(async () => {
        await sql.begin(async (tx) => { await tx.unsafe(m.up_sql); });
      });
      const [updated] = await sql<any[]>`
        update admin.migrations
           set applied_at = now(), applied_by = ${actor.userId},
               rolled_back_at = null, rolled_back_by = null
         where id = ${req.params.id}
         returning id, version, name, applied_at`;
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.apply', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name, version: String(m.version) }, result: 'ok', duration_ms: t.ms,
      });
      return reply.send({ ok: true, migration: updated });
    } catch (e: any) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.apply', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name }, result: 'error', error_message: e.message,
      });
      return reply.code(400).send({ error: 'apply_failed', message: e.message });
    }
  });

  app.post<{ Params: { id: string } }>('/admin/v1/migrations/:id/rollback', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (!m.applied_at || m.rolled_back_at) return reply.code(409).send({ error: 'not applied' });
    await assertRole(cfg, m.project_id, actor);

    // Refuse if any newer migration (higher version, same project scope) is currently applied.
    const newer = await sql<any[]>`
      select id, version, name from admin.migrations
       where (project_id is not distinct from ${m.project_id})
         and version > ${m.version}
         and applied_at is not null and rolled_back_at is null
       order by version`;
    if (newer.length) {
      return reply.code(409).send({
        error: 'dependent_migrations_applied',
        message: 'Rollback the following newer migrations first.',
        newer,
      });
    }
    if (!m.down_sql || !m.down_sql.trim()) {
      return reply.code(400).send({ error: 'no_down_sql', message: 'This migration has no down_sql.' });
    }
    try {
      const t = await timed(async () => {
        await sql.begin(async (tx) => { await tx.unsafe(m.down_sql); });
      });
      const [updated] = await sql<any[]>`
        update admin.migrations
           set rolled_back_at = now(), rolled_back_by = ${actor.userId}
         where id = ${req.params.id}
         returning id, version, name, rolled_back_at`;
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.rollback', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name, version: String(m.version) }, result: 'ok', duration_ms: t.ms,
      });
      return reply.send({ ok: true, migration: updated });
    } catch (e: any) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.rollback', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name }, result: 'error', error_message: e.message,
      });
      return reply.code(400).send({ error: 'rollback_failed', message: e.message });
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/v1/migrations/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (m.applied_at && !m.rolled_back_at) {
      return reply.code(409).send({ error: 'cannot delete applied migration' });
    }
    await assertRole(cfg, m.project_id, actor);
    await sql`delete from admin.migrations where id = ${req.params.id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: m.project_id,
      action: 'migration.delete', resource_type: 'migration', resource_id: m.id,
      params: {}, result: 'ok',
    });
    return reply.send({ message: 'Deleted' });
  });
}
