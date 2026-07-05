import type { FastifyInstance } from 'fastify';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { pingDb, getSql } from '../db/pool.js';
import { getS3 } from '../storage/s3.js';
import type { Config } from '../config.js';


const startTime = Date.now();

type CheckResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
  [k: string]: unknown;
};

async function checkPostgres(cfg: Config): Promise<CheckResult> {
  const r = await pingDb(cfg);
  return { ...r, driver: 'postgres.js', url: redactUrl(cfg.DATABASE_URL) };
}

async function checkS3(cfg: Config): Promise<CheckResult> {
  const start = Date.now();
  try {
    const s3 = getS3(cfg);
    await s3.send(new HeadBucketCommand({ Bucket: cfg.S3_BUCKET }));
    return {
      ok: true,
      latencyMs: Date.now() - start,
      endpoint: cfg.S3_ENDPOINT ?? 'aws',
      bucket: cfg.S3_BUCKET,
      region: cfg.S3_REGION,
    };
  } catch (e: any) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e?.message ?? String(e),
      code: e?.name ?? e?.Code,
      endpoint: cfg.S3_ENDPOINT ?? 'aws',
      bucket: cfg.S3_BUCKET,
      region: cfg.S3_REGION,
    };
  }
}

function redactUrl(u: string): string {
  try {
    const p = new URL(u);
    if (p.password) p.password = '***';
    return p.toString();
  } catch {
    return 'invalid-url';
  }
}

export async function healthRoutes(app: FastifyInstance, cfg: Config) {
  // Liveness — process alive
  app.get('/livez', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    ts: new Date().toISOString(),
  }));

  // Readiness — dependencies reachable
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, any> = {};

    checks.db = await pingDb(cfg);

    // JWT sign+verify round-trip
    try {
      const token = await app.jwt.sign({ probe: true }, { expiresIn: '10s' });
      await app.jwt.verify(token);
      checks.jwt = { ok: true };
    } catch (e: any) {
      checks.jwt = { ok: false, error: e.message };
    }

    const healthy = Object.values(checks).every((c: any) => c.ok);
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ready' : 'degraded', checks, ts: new Date().toISOString() };
  });

  // Detailed per-dependency health — Postgres + S3/MinIO breakdown
  app.get('/health/deps', async (_req, reply) => {
    const [postgresCheck, s3Check] = await Promise.all([checkPostgres(cfg), checkS3(cfg)]);
    const deps = { postgres: postgresCheck, s3: s3Check };
    const healthy = postgresCheck.ok && s3Check.ok;
    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      ts: new Date().toISOString(),
      deps,
    };
  });

  // Migration + audit_log schema health
  app.get('/health/migrations', async (_req, reply) => {
    const sql = getSql(cfg);
    const out: Record<string, any> = { ts: new Date().toISOString() };

    try {
      const applied = await sql`
        select name, applied_at
        from _pluto_migrations
        order by name asc`;
      out.migrations = {
        ok: true,
        count: applied.length,
        current: applied.length ? applied[applied.length - 1].name : null,
        applied: applied.map((r: any) => r.name),
      };
    } catch (e: any) {
      out.migrations = { ok: false, error: e.message };
    }

    // audit_log required columns
    const requiredCols: Record<string, string> = {
      project_id: 'uuid',
      resource_type: 'text',
      resource_id: 'text',
      params: 'jsonb',
      result: 'text',
      duration_ms: 'integer',
      error_message: 'text',
    };
    try {
      const cols = await sql`
        select column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = 'admin' and table_name = 'audit_log'`;
      const byName: Record<string, any> = {};
      for (const c of cols) byName[c.column_name] = c;
      const missing: string[] = [];
      const typeMismatch: Array<{ column: string; expected: string; actual: string }> = [];
      for (const [name, expected] of Object.entries(requiredCols)) {
        const c = byName[name];
        if (!c) { missing.push(name); continue; }
        if (c.data_type !== expected) {
          typeMismatch.push({ column: name, expected, actual: c.data_type });
        }
      }
      out.audit_log_columns = {
        ok: missing.length === 0 && typeMismatch.length === 0,
        present: Object.keys(byName).length,
        missing,
        typeMismatch,
      };
    } catch (e: any) {
      out.audit_log_columns = { ok: false, error: e.message };
    }

    // Foreign key: audit_log.project_id -> admin.projects(id)
    try {
      const [fk] = await sql`
        select c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        where c.conrelid = 'admin.audit_log'::regclass
          and c.contype = 'f'
          and c.conname = 'audit_log_project_fk'`;
      out.audit_log_fk = fk
        ? { ok: true, name: fk.conname, definition: fk.def }
        : { ok: false, error: 'audit_log_project_fk missing' };
    } catch (e: any) {
      out.audit_log_fk = { ok: false, error: e.message };
    }

    // Required indexes
    const requiredIdx = [
      'audit_log_created_at_idx',
      'audit_log_project_idx',
      'audit_log_actor_idx',
      'audit_log_action_idx',
    ];
    try {
      const rows = await sql`
        select indexname from pg_indexes
        where schemaname = 'admin' and tablename = 'audit_log'`;
      const have = new Set(rows.map((r: any) => r.indexname));
      const missingIdx = requiredIdx.filter((n) => !have.has(n));
      out.audit_log_indexes = {
        ok: missingIdx.length === 0,
        present: [...have],
        missing: missingIdx,
      };
    } catch (e: any) {
      out.audit_log_indexes = { ok: false, error: e.message };
    }

    const healthy =
      out.migrations?.ok &&
      out.audit_log_columns?.ok &&
      out.audit_log_fk?.ok &&
      out.audit_log_indexes?.ok;
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', ...out };
  });

  // Public health snapshot for /api/pluto/status probes
  app.get('/healthz', async () => ({ status: 'ok', service: 'pluto-api', ts: new Date().toISOString() }));

  // Auth v1 health (SDK / Lovable dashboard probe)
  app.get('/auth/v1/health', async () => ({ status: 'ok', service: 'pluto-auth', ts: new Date().toISOString() }));
}

