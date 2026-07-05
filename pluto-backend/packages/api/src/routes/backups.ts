import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const BACKUP_DIR = process.env.PLUTO_BACKUP_DIR || '/tmp/pluto-backups';

const createBody = z.object({
  project_id: z.string().uuid(),
  kind: z.enum(['full', 'schema', 'data']).default('full'),
});

const scheduleBody = z.object({
  project_id: z.string().uuid(),
  cron_expr: z.string().min(9).max(64),
  kind: z.enum(['full', 'schema', 'data']).default('full'),
  retention_days: z.number().int().min(1).max(365).default(14),
  enabled: z.boolean().default(true),
});

function runPgDump(dbUrl: string, kind: string, outPath: string): Promise<number> {
  const args = ['-Fc', '--no-owner', '--no-privileges'];
  if (kind === 'schema') args.push('--schema-only');
  if (kind === 'data') args.push('--data-only');
  args.push(dbUrl);
  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(outPath);
    proc.stdout.pipe(out);
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(code) : reject(new Error(`pg_dump exit ${code}: ${stderr}`))
    );
  });
}

function runPgRestore(dbUrl: string, inPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-d', dbUrl, inPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(code) : reject(new Error(`pg_restore exit ${code}: ${stderr}`))
    );
  });
}

export async function backupsRoutes(app: FastifyInstance, cfg: Config) {
  await mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});

  // List
  app.get('/admin/v1/backups', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    return sql`
      select id, kind, status, size_bytes, error_message, created_at, completed_at
        from admin.backup_jobs
       where project_id = ${q.project_id}
       order by created_at desc
       limit 100`;
  });

  // Create backup (runs async)
  app.post('/admin/v1/backups', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createBody.parse(req.body);
    await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);

    const [job] = await sql`
      insert into admin.backup_jobs (project_id, kind, requested_by, status)
      values (${body.project_id}, ${body.kind}, ${actor.userId}, 'running')
      returning *`;

    const outPath = join(BACKUP_DIR, `${body.project_id}_${job.id}.dump`);

    // Fire-and-forget; status updates in DB
    (async () => {
      try {
        await sql`update admin.backup_jobs set started_at = now() where id = ${job.id}`;
        await runPgDump(cfg.DATABASE_URL, body.kind, outPath);
        const st = await stat(outPath);
        await sql`
          update admin.backup_jobs
             set status='succeeded', size_bytes=${st.size}, storage_path=${outPath}, completed_at=now()
           where id = ${job.id}`;
      } catch (e: any) {
        await sql`
          update admin.backup_jobs
             set status='failed', error_message=${String(e.message ?? e)}, completed_at=now()
           where id = ${job.id}`;
      }
    })();

    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: 'backup.create', resource_type: 'backup', resource_id: job.id, params: body,
    });
    reply.code(202);
    return job;
  });

  // Download
  app.get('/admin/v1/backups/:id/download', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [job] = await sql`select * from admin.backup_jobs where id = ${id}`;
    if (!job) { reply.code(404); return { error: 'not_found' }; }
    await requireProjectRole(cfg, job.project_id, actor, ['owner', 'admin']);
    if (job.status !== 'succeeded' || !job.storage_path) {
      reply.code(409); return { error: 'not_ready', status: job.status };
    }
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="backup-${id}.dump"`);
    return reply.send(createReadStream(job.storage_path));
  });

  // Restore (from a stored backup job)
  app.post('/admin/v1/backups/:id/restore', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [job] = await sql`select * from admin.backup_jobs where id = ${id}`;
    if (!job) { reply.code(404); return { error: 'not_found' }; }
    await requireProjectRole(cfg, job.project_id, actor, ['owner']);
    if (!job.storage_path) { reply.code(409); return { error: 'no_artifact' }; }

    const confirm = (req.headers['x-pluto-confirm'] || '').toString();
    if (confirm !== 'RESTORE') {
      reply.code(428);
      return { error: 'confirmation_required', hint: 'Send header X-Pluto-Confirm: RESTORE' };
    }

    try {
      await runPgRestore(cfg.DATABASE_URL, job.storage_path);
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: job.project_id,
        action: 'backup.restore', resource_type: 'backup', resource_id: id,
      });
      return { ok: true };
    } catch (e: any) {
      reply.code(500);
      return { error: 'restore_failed', message: String(e.message ?? e) };
    }
  });

  // Schedules
  app.get('/admin/v1/backup-schedules', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select * from admin.backup_schedules where project_id = ${q.project_id} order by created_at desc`;
  });

  app.post('/admin/v1/backup-schedules', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = scheduleBody.parse(req.body);
    await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const [row] = await sql`
      insert into admin.backup_schedules (project_id, cron_expr, kind, retention_days, enabled)
      values (${body.project_id}, ${body.cron_expr}, ${body.kind}, ${body.retention_days}, ${body.enabled})
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: 'backup.schedule.create', resource_type: 'backup_schedule', resource_id: row.id, params: body,
    });
    return row;
  });

  app.delete('/admin/v1/backup-schedules/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [row] = await sql`select project_id from admin.backup_schedules where id = ${id}`;
    if (!row) return { ok: true };
    await requireProjectRole(cfg, row.project_id, actor, ['owner', 'admin']);
    await sql`delete from admin.backup_schedules where id = ${id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: row.project_id,
      action: 'backup.schedule.delete', resource_type: 'backup_schedule', resource_id: id,
    });
    return { ok: true };
  });
}
