// Durable store for "migrate from Lovable / Supabase / GitHub" import jobs.
//
// Jobs are persisted in the Pluto backend (Postgres) through the existing
// service-role SQL surface (`/admin/v1/sql/exec`) instead of process memory,
// because the ingest webhook and the dashboard polling calls can land on
// different stateless workers.
//
// Server-only: this file must never be imported from client code (the
// `.server.ts` suffix enforces that at build time).
import { vpsFetch } from "./vps-client";

export type ImportSource = "lovable" | "supabase" | "github";
export type ImportJobStatus =
  | "received"
  | "translated"
  | "dry_run_ok"
  | "dry_run_failed"
  | "applied"
  | "apply_failed"
  | "rolled_back";

export type ImportJobPayload = {
  event_id: string;
  source: ImportSource;
  repo?: string | null;
  ref?: string | null;
  zipball_url?: string | null;
  lovable?: { project_id?: string; name?: string; url?: string } | null;
  supabase?: { ref?: string; region?: string; schema_sql?: string; tables?: string[] } | null;
  target?: { project_id?: string; slug?: string } | null;
};

export type ImportJob = {
  id: string;
  event_id: string;
  source: ImportSource;
  status: ImportJobStatus;
  repo: string | null;
  slug: string | null;
  payload: ImportJobPayload;
  migration_sql: string | null;
  report: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ExecResult = { ok?: boolean; rows?: unknown[]; row_count?: number; error?: string; message?: string };

async function exec(sql: string, params: unknown[] = [], write = false): Promise<ExecResult> {
  return vpsFetch<ExecResult>("/admin/v1/sql/exec", {
    method: "POST",
    mode: "service",
    timeoutMs: 60_000,
    body: {
      sql,
      params,
      read_only: !write,
      allow_dangerous: write,
      confirm_destructive: write,
    },
  });
}

let ensured = false;

/** Create the jobs table if it does not exist yet (idempotent, cached per isolate). */
export async function ensureImportJobsTable(): Promise<void> {
  if (ensured) return;
  await exec(
    `create schema if not exists admin;
     create table if not exists admin.import_jobs (
       id uuid primary key default gen_random_uuid(),
       event_id text not null unique,
       source text not null,
       status text not null default 'received',
       repo text,
       slug text,
       payload jsonb not null default '{}'::jsonb,
       migration_sql text,
       report jsonb,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     );
     create index if not exists import_jobs_created_idx on admin.import_jobs (created_at desc);`,
    [],
    true,
  );
  ensured = true;
}

function rowToJob(r: Record<string, unknown>): ImportJob {
  return {
    id: String(r.id),
    event_id: String(r.event_id),
    source: r.source as ImportSource,
    status: r.status as ImportJobStatus,
    repo: (r.repo as string) ?? null,
    slug: (r.slug as string) ?? null,
    payload: (r.payload as ImportJobPayload) ?? ({} as ImportJobPayload),
    migration_sql: (r.migration_sql as string) ?? null,
    report: (r.report as Record<string, unknown>) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/** Insert a job. Returns null when the event_id was already ingested (replay). */
export async function createImportJob(
  payload: ImportJobPayload,
  migrationSql: string | null,
): Promise<{ job: ImportJob | null; duplicate: boolean }> {
  await ensureImportJobsTable();
  const res = await exec(
    `insert into admin.import_jobs (event_id, source, repo, slug, payload, migration_sql)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (event_id) do nothing
     returning *`,
    [
      payload.event_id,
      payload.source,
      payload.repo ?? null,
      payload.target?.slug ?? null,
      JSON.stringify(payload),
      migrationSql,
    ],
    true,
  );
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  if (!rows.length) return { job: null, duplicate: true };
  return { job: rowToJob(rows[0]), duplicate: false };
}

export async function listImportJobs(limit = 50): Promise<ImportJob[]> {
  await ensureImportJobsTable();
  const res = await exec(
    `select * from admin.import_jobs order by created_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return ((res.rows ?? []) as Record<string, unknown>[]).map(rowToJob);
}

export async function getImportJobById(id: string): Promise<ImportJob | null> {
  await ensureImportJobsTable();
  const res = await exec(`select * from admin.import_jobs where id = $1`, [id]);
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  return rows.length ? rowToJob(rows[0]) : null;
}

export async function updateImportJob(
  id: string,
  patch: { status?: ImportJobStatus; report?: unknown; migration_sql?: string | null },
): Promise<ImportJob | null> {
  await ensureImportJobsTable();
  const res = await exec(
    `update admin.import_jobs set
       status = coalesce($2, status),
       report = coalesce($3::jsonb, report),
       migration_sql = coalesce($4, migration_sql),
       updated_at = now()
     where id = $1
     returning *`,
    [
      id,
      patch.status ?? null,
      patch.report === undefined ? null : JSON.stringify(patch.report),
      patch.migration_sql ?? null,
    ],
    true,
  );
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  return rows.length ? rowToJob(rows[0]) : null;
}

/** Run the job's migration SQL against Pluto. `dryRun` wraps it in a rolled-back tx. */
export async function runImportSql(sql: string, dryRun: boolean): Promise<ExecResult> {
  const body = dryRun
    ? `begin;\n${sql}\nrollback;`
    : sql;
  return vpsFetch<ExecResult>("/admin/v1/sql/exec", {
    method: "POST",
    mode: "service",
    timeoutMs: 180_000,
    body: { sql: body, read_only: false, allow_dangerous: true, confirm_destructive: true },
  });
}
