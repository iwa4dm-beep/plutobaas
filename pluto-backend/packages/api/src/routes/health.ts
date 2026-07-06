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

    // auth.* compatibility shim probes — these functions are required by
    // migrations 0016+. If any is missing or throws, surface the exact
    // Postgres error so deploy tooling can react (see deploy/verify-*.sh).
    const authProbes: Array<{ name: string; sql: string }> = [
      { name: 'auth.uid',  sql: 'select auth.uid()  as v' },
      { name: 'auth.role', sql: 'select auth.role() as v' },
      { name: 'auth.jwt',  sql: 'select auth.jwt()  as v' },
    ];
    const authResults: Record<string, any> = {};
    let authOk = true;
    for (const p of authProbes) {
      try {
        await sql.unsafe(p.sql);
        authResults[p.name] = { ok: true };
      } catch (e: any) {
        authOk = false;
        authResults[p.name] = {
          ok: false,
          error: e.message,
          code: e.code ?? null,           // 42883 = undefined_function
          hint: e.hint ?? null,
          routine: e.routine ?? null,
        };
      }
    }
    out.auth_shim = { ok: authOk, probes: authResults };

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
      out.auth_shim?.ok &&
      out.audit_log_columns?.ok &&
      out.audit_log_fk?.ok &&
      out.audit_log_indexes?.ok;
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', ...out };
  });

  // Phase-17 required-schema check — verifies the tables + columns the
  // dashboard's workspace/project/token flows depend on. Returns 200 with
  // {ok:true, checks:[...]} when everything is present; 503 with the
  // missing objects listed so `deploy/recover-api.sh` / smoke scripts can
  // fail fast BEFORE the dashboard reports 404s on create.
  app.get('/health/migrations/required', async (_req, reply) => {
    const sql = getSql(cfg);
    const required = [
      { kind: 'table',  schema: 'admin', name: 'workspaces' },
      { kind: 'table',  schema: 'admin', name: 'workspace_members' },
      { kind: 'table',  schema: 'admin', name: 'workspace_tokens' },
      { kind: 'table',  schema: 'admin', name: 'projects' },
      { kind: 'table',  schema: 'admin', name: 'project_members' },
      { kind: 'table',  schema: 'admin', name: 'api_keys' },
      { kind: 'column', schema: 'admin', name: 'projects.workspace_id' },
      { kind: 'column', schema: 'admin', name: 'workspace_tokens.token_hash' },
      { kind: 'column', schema: 'admin', name: 'workspace_tokens.scopes' },
    ] as const;
    const results: Array<{ object: string; kind: string; ok: boolean; error?: string }> = [];
    for (const r of required) {
      try {
        if (r.kind === 'table') {
          const [row] = await sql<any[]>`
            select 1 as ok from information_schema.tables
             where table_schema = ${r.schema} and table_name = ${r.name} limit 1`;
          results.push({ object: `${r.schema}.${r.name}`, kind: r.kind, ok: !!row });
        } else {
          const [tbl, col] = r.name.split('.');
          const [row] = await sql<any[]>`
            select 1 as ok from information_schema.columns
             where table_schema = ${r.schema} and table_name = ${tbl} and column_name = ${col} limit 1`;
          results.push({ object: `${r.schema}.${r.name}`, kind: r.kind, ok: !!row });
        }
      } catch (e: any) {
        results.push({ object: `${r.schema}.${r.name}`, kind: r.kind, ok: false, error: e.message });
      }
    }
    const missing = results.filter((r) => !r.ok);
    const healthy = missing.length === 0;
    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      required_migration: '0029_workspaces_tokens.sql',
      missing: missing.map((m) => m.object),
      checks: results,
      hint: healthy
        ? undefined
        : "Run `docker compose exec api node dist/migrate.js` or set AUTO_MIGRATE=1 and restart the api container.",
    };
  });

  // Public health snapshot for /api/pluto/status probes
  app.get('/healthz', async () => ({ status: 'ok', service: 'pluto-api', ts: new Date().toISOString() }));


  // Per-module health snapshots (Lovable dashboard probes).
  // Every module lives in this single Fastify server; a 200 here confirms
  // the process is serving that module's route surface.
  const modules: Array<[string, string]> = [
    ['/auth/v1/health',      'pluto-auth'],
    ['/rest/v1/health',      'pluto-rest'],
    ['/storage/v1/health',   'pluto-storage'],
    ['/functions/v1/health', 'pluto-functions'],
    ['/jobs/v1/health',      'pluto-jobs'],
    ['/admin/v1/health',     'pluto-admin'],
    ['/tokens/v1/health',    'pluto-tokens'],
  ];
  for (const [path, service] of modules) {
    app.get(path, async () => ({ status: 'ok', service, ts: new Date().toISOString() }));
  }

  // Aggregated snapshot — one call, every module. Used by quickstart, CI
  // smoke script, and docker healthcheck. Returns 200 if every module is up,
  // 503 if any is down. `realtime` lives in routes/realtime.ts and exposes
  // its own /realtime/v1/health; we call it via inject() so a single HTTP
  // hit reflects the real router state.
  app.get('/v1/health', async (_req, reply) => {
    const probes = [
      ...modules.map(([p, s]) => ({ name: s.replace(/^pluto-/, ''), path: p })),
      { name: 'realtime', path: '/realtime/v1/health' },
      { name: 'core',     path: '/readyz' },
    ];
    const started = Date.now();
    const results = await Promise.all(probes.map(async (p) => {
      const t0 = Date.now();
      try {
        const res = await app.inject({ method: 'GET', url: p.path });
        return {
          name: p.name, path: p.path,
          status: res.statusCode >= 200 && res.statusCode < 300 ? 'up' : 'down',
          code: res.statusCode, latency_ms: Date.now() - t0,
        };
      } catch (e) {
        return { name: p.name, path: p.path, status: 'down', latency_ms: Date.now() - t0, error: (e as Error).message };
      }
    }));
    const ok = results.every((r) => r.status === 'up');
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', took_ms: Date.now() - started, ts: new Date().toISOString(), modules: results };
  });
}


