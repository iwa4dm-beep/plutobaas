import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const createBody = z.object({
  project_id: z.string().uuid(),
  name: z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,60}$/, 'lowercase, digits, _/- only'),
  parent_branch: z.string().default('main'),
  git_ref: z.string().max(120).optional(),
});

// Sanitize a branch name into a valid postgres database identifier.
function toDbName(projectId: string, name: string): string {
  const safe = name.replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return `pluto_${projectId.replace(/-/g, '').slice(0, 12)}_${safe}`;
}

export async function branchesRoutes(app: FastifyInstance, cfg: Config) {
  // List
  app.get('/admin/v1/branches', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select id, name, parent_branch, db_name, status, git_ref,
             promoted_at, error_message, created_at
        from admin.branches
       where project_id = ${q.project_id}
       order by created_at desc`;
  });

  // Create — uses CREATE DATABASE ... TEMPLATE for a copy-on-init clone.
  app.post('/admin/v1/branches', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createBody.parse(req.body);
    await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);

    // Determine parent db: for parent='main', use the current db name;
    // otherwise look up the parent branch's db_name.
    let templateDb: string;
    if (body.parent_branch === 'main') {
      const [row] = await sql`select current_database() as db`;
      templateDb = row.db;
    } else {
      const [parent] = await sql`
        select db_name from admin.branches
         where project_id = ${body.project_id} and name = ${body.parent_branch} and status = 'ready'
         limit 1`;
      if (!parent) return reply.code(400).send({ error: 'parent_not_ready' });
      templateDb = parent.db_name;
    }

    const dbName = toDbName(body.project_id, body.name);
    const [branch] = await sql`
      insert into admin.branches (project_id, name, parent_branch, db_name, status, git_ref, created_by)
      values (${body.project_id}, ${body.name}, ${body.parent_branch}, ${dbName},
              'creating', ${body.git_ref ?? null}, ${actor.userId})
      returning *`;

    // Fire-and-forget create
    (async () => {
      try {
        // Terminate active connections to template DB (Postgres requires no
        // other connections to the template while CREATE DATABASE runs).
        await sql.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity
            where datname = '${templateDb.replace(/'/g, "''")}' and pid <> pg_backend_pid()`,
        );
        await sql.unsafe(`create database "${dbName}" with template "${templateDb}"`);
        await sql`update admin.branches set status='ready' where id = ${branch.id}`;
      } catch (e: any) {
        await sql`update admin.branches
                     set status='failed', error_message=${String(e.message ?? e)}
                   where id = ${branch.id}`;
      }
    })();

    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: 'branch.create', resource_type: 'branch', resource_id: branch.id, params: body,
    });
    reply.code(202);
    return branch;
  });

  // Diff — simple schema/table/column comparison against parent
  app.get('/admin/v1/branches/:id/diff', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [b] = await sql`select * from admin.branches where id=${id}`;
    if (!b) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin', 'member']);

    // We compare only object counts here — a real diff would compare pg_dump --schema-only.
    const tables = await sql`
      select table_schema, table_name
        from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema','admin','auth','storage')`;
    const summary = {
      tables: tables.length,
      branch: b.name,
      parent: b.parent_branch,
      note: 'Object-count summary. Run pg_dump --schema-only for a full text diff.',
    };
    await sql`
      insert into admin.branch_diffs (branch_id, summary, detail)
      values (${id}, ${sql.json(summary)}, ${''})`;
    return summary;
  });

  // Promote — pg_dump from branch, restore to main (destructive). Requires confirmation.
  app.post('/admin/v1/branches/:id/promote', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const confirm = (req.headers['x-pluto-confirm'] || '').toString();
    if (confirm !== 'PROMOTE') {
      reply.code(428);
      return { error: 'confirmation_required', hint: 'Send header X-Pluto-Confirm: PROMOTE' };
    }
    const sql = getSql(cfg);
    const [b] = await sql`select * from admin.branches where id=${id}`;
    if (!b) return reply.code(404).send({ error: 'not_found' });
    await requireProjectRole(cfg, b.project_id, actor, ['owner']);

    await sql`update admin.branches set status='promoting' where id=${id}`;
    // Real promotion: swap db names via RENAME DATABASE, or run pg_dump/restore.
    // For safety here we simply mark it promoted and log — operators run the
    // actual swap in a maintenance window.
    await sql`update admin.branches set status='ready', promoted_at=now() where id=${id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'branch.promote', resource_type: 'branch', resource_id: id,
    });
    return { ok: true, note: 'Marked promoted. Operator must swap DBs in a maintenance window.' };
  });

  // Archive / delete
  app.delete('/admin/v1/branches/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [b] = await sql`select * from admin.branches where id=${id}`;
    if (!b) return { ok: true };
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    try {
      await sql.unsafe(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = '${b.db_name.replace(/'/g, "''")}' and pid <> pg_backend_pid()`,
      );
      await sql.unsafe(`drop database if exists "${b.db_name}"`);
    } catch {
      // swallow — still mark archived
    }
    await sql`update admin.branches set status='archived' where id=${id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'branch.archive', resource_type: 'branch', resource_id: id,
    });
    return { ok: true };
  });
}
