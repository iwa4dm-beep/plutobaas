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
  applied_at: string | null;
  applied_by: string | null;
  selection: string[] | null;
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  resume_step: string | null;
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
     create index if not exists import_jobs_created_idx on admin.import_jobs (created_at desc);
     alter table admin.import_jobs add column if not exists applied_at timestamptz;
     alter table admin.import_jobs add column if not exists applied_by text;
     alter table admin.import_jobs add column if not exists selection jsonb;
     alter table admin.import_jobs add column if not exists paused boolean not null default false;
     alter table admin.import_jobs add column if not exists paused_by text;
     alter table admin.import_jobs add column if not exists paused_at timestamptz;
     alter table admin.import_jobs add column if not exists resume_step text;`,
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
    applied_at: (r.applied_at as string) ?? null,
    applied_by: (r.applied_by as string) ?? null,
    selection: Array.isArray(r.selection) ? (r.selection as string[]) : null,
    paused: r.paused === true,
    paused_by: (r.paused_by as string) ?? null,
    paused_at: (r.paused_at as string) ?? null,
    resume_step: (r.resume_step as string) ?? null,
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
  const job = rowToJob(rows[0]);
  await appendImportEvent({
    jobId: job.id,
    step: "received",
    message: `Ingested ${payload.source} import${payload.repo ? ` from ${payload.repo}` : ""}`,
    detail: { event_id: payload.event_id, has_schema_sql: Boolean(payload.supabase?.schema_sql) },
  });
  return { job, duplicate: false };
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

/* ------------------------------------------------------------------ */
/* Import audit history: one row per step of a job's lifecycle.        */
/* ------------------------------------------------------------------ */

export type ImportEventStep =
  | "received"
  | "translated"
  | "selection_changed"
  | "dry_run"
  | "apply"
  | "pause"
  | "resume"
  | "retry"
  | "version_saved"
  | "version_restored"
  | "rollback";

export type ImportJobEvent = {
  id: string;
  job_id: string;
  step: ImportEventStep;
  ok: boolean;
  actor_id: string | null;
  actor_email: string | null;
  row_count: number | null;
  duration_ms: number | null;
  message: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

let eventsEnsured = false;

export async function ensureImportEventsTable(): Promise<void> {
  if (eventsEnsured) return;
  await ensureImportJobsTable();
  await exec(
    `create table if not exists admin.import_job_events (
       id uuid primary key default gen_random_uuid(),
       job_id uuid not null references admin.import_jobs(id) on delete cascade,
       step text not null,
       ok boolean not null default true,
       actor_id text,
       actor_email text,
       row_count integer,
       duration_ms integer,
       message text,
       detail jsonb,
       created_at timestamptz not null default now()
     );
     create index if not exists import_job_events_job_idx
       on admin.import_job_events (job_id, created_at desc);
     create index if not exists import_job_events_created_idx
       on admin.import_job_events (created_at desc);
     alter table admin.import_jobs add column if not exists applied_at timestamptz;
     alter table admin.import_jobs add column if not exists applied_by text;
     alter table admin.import_jobs add column if not exists selection jsonb;`,
    [],
    true,
  );
  eventsEnsured = true;
}

function rowToEvent(r: Record<string, unknown>): ImportJobEvent {
  return {
    id: String(r.id),
    job_id: String(r.job_id),
    step: r.step as ImportEventStep,
    ok: r.ok !== false,
    actor_id: (r.actor_id as string) ?? null,
    actor_email: (r.actor_email as string) ?? null,
    row_count: r.row_count === null || r.row_count === undefined ? null : Number(r.row_count),
    duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    message: (r.message as string) ?? null,
    detail: (r.detail as Record<string, unknown>) ?? null,
    created_at: String(r.created_at),
  };
}

export async function appendImportEvent(e: {
  jobId: string;
  step: ImportEventStep;
  ok?: boolean;
  actorId?: string | null;
  actorEmail?: string | null;
  rowCount?: number | null;
  durationMs?: number | null;
  message?: string | null;
  detail?: unknown;
}): Promise<void> {
  try {
    await ensureImportEventsTable();
    await exec(
      `insert into admin.import_job_events
         (job_id, step, ok, actor_id, actor_email, row_count, duration_ms, message, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        e.jobId,
        e.step,
        e.ok !== false,
        e.actorId ?? null,
        e.actorEmail ?? null,
        e.rowCount ?? null,
        e.durationMs ?? null,
        e.message ? String(e.message).slice(0, 2000) : null,
        e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 20000),
      ],
      true,
    );
  } catch {
    // Audit trail must never break the operation it is describing.
  }
}

export async function listImportEvents(jobId: string | null, limit = 200): Promise<ImportJobEvent[]> {
  await ensureImportEventsTable();
  const res = jobId
    ? await exec(
        `select * from admin.import_job_events where job_id = $1 order by created_at asc limit $2`,
        [jobId, Math.min(Math.max(limit, 1), 500)],
      )
    : await exec(
        `select e.*, j.repo as job_repo, j.source as job_source, j.event_id as job_event_id
           from admin.import_job_events e
           join admin.import_jobs j on j.id = e.job_id
          order by e.created_at desc limit $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
  return ((res.rows ?? []) as Record<string, unknown>[]).map((r) => ({
    ...rowToEvent(r),
    detail: {
      ...(rowToEvent(r).detail ?? {}),
      ...(r.job_repo !== undefined
        ? { job_repo: r.job_repo, job_source: r.job_source, job_event_id: r.job_event_id }
        : {}),
    },
  }));
}

/** Record who applied a job and when (audit columns on the job row). */
export async function markApplied(jobId: string, actorEmail: string | null): Promise<void> {
  await ensureImportEventsTable();
  await exec(
    `update admin.import_jobs set applied_at = now(), applied_by = $2, updated_at = now() where id = $1`,
    [jobId, actorEmail ?? null],
    true,
  );
}

/** Persist the schema/table/view selection an admin picked for this job. */
export async function saveSelection(jobId: string, keys: string[]): Promise<void> {
  await ensureImportEventsTable();
  await exec(
    `update admin.import_jobs set selection = $2::jsonb, updated_at = now() where id = $1`,
    [jobId, JSON.stringify(keys)],
    true,
  );
}

/* ------------------------------------------------------------------ */
/* SQL version archive: every generated migration is kept immutably.   */
/* ------------------------------------------------------------------ */

export type ImportSqlVersion = {
  id: string;
  job_id: string;
  version: number;
  kind: string;
  sql: string;
  selection: string[] | null;
  counts: Record<string, number> | null;
  destructive_count: number | null;
  actor_email: string | null;
  note: string | null;
  created_at: string;
};

let versionsEnsured = false;

export async function ensureImportVersionsTable(): Promise<void> {
  if (versionsEnsured) return;
  await ensureImportJobsTable();
  await exec(
    `create table if not exists admin.import_job_versions (
       id uuid primary key default gen_random_uuid(),
       job_id uuid not null references admin.import_jobs(id) on delete cascade,
       version integer not null,
       kind text not null default 'translate',
       sql text not null,
       selection jsonb,
       counts jsonb,
       destructive_count integer,
       actor_email text,
       note text,
       created_at timestamptz not null default now(),
       unique (job_id, version)
     );
     create index if not exists import_job_versions_job_idx
       on admin.import_job_versions (job_id, version desc);`,
    [],
    true,
  );
  versionsEnsured = true;
}

function rowToVersion(r: Record<string, unknown>): ImportSqlVersion {
  return {
    id: String(r.id),
    job_id: String(r.job_id),
    version: Number(r.version),
    kind: String(r.kind ?? "translate"),
    sql: String(r.sql ?? ""),
    selection: Array.isArray(r.selection) ? (r.selection as string[]) : null,
    counts: (r.counts as Record<string, number>) ?? null,
    destructive_count:
      r.destructive_count === null || r.destructive_count === undefined ? null : Number(r.destructive_count),
    actor_email: (r.actor_email as string) ?? null,
    note: (r.note as string) ?? null,
    created_at: String(r.created_at),
  };
}

/**
 * Archive a generated migration as the next version for this job.
 * Identical consecutive SQL is de-duplicated so polling never inflates history.
 */
export async function saveSqlVersion(input: {
  jobId: string;
  kind: string;
  sql: string;
  selection?: string[] | null;
  counts?: Record<string, number> | null;
  destructiveCount?: number | null;
  actorEmail?: string | null;
  note?: string | null;
}): Promise<ImportSqlVersion | null> {
  await ensureImportVersionsTable();
  const latest = await exec(
    `select sql, version from admin.import_job_versions where job_id = $1 order by version desc limit 1`,
    [input.jobId],
  );
  const prev = ((latest.rows ?? []) as Record<string, unknown>[])[0];
  if (prev && String(prev.sql) === input.sql && input.kind === "translate") return null;
  const next = prev ? Number(prev.version) + 1 : 1;
  const res = await exec(
    `insert into admin.import_job_versions
       (job_id, version, kind, sql, selection, counts, destructive_count, actor_email, note)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     returning *`,
    [
      input.jobId,
      next,
      input.kind,
      input.sql,
      JSON.stringify(input.selection ?? null),
      JSON.stringify(input.counts ?? null),
      input.destructiveCount ?? null,
      input.actorEmail ?? null,
      input.note ?? null,
    ],
    true,
  );
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  return rows.length ? rowToVersion(rows[0]) : null;
}

export async function listSqlVersions(jobId: string, limit = 50): Promise<ImportSqlVersion[]> {
  await ensureImportVersionsTable();
  const res = await exec(
    `select * from admin.import_job_versions where job_id = $1 order by version desc limit $2`,
    [jobId, Math.min(Math.max(limit, 1), 200)],
  );
  return ((res.rows ?? []) as Record<string, unknown>[]).map(rowToVersion);
}

export async function getSqlVersion(jobId: string, version: number): Promise<ImportSqlVersion | null> {
  await ensureImportVersionsTable();
  const res = await exec(
    `select * from admin.import_job_versions where job_id = $1 and version = $2`,
    [jobId, version],
  );
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  return rows.length ? rowToVersion(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Pause / resume                                                      */
/* ------------------------------------------------------------------ */

export async function setPaused(
  jobId: string,
  paused: boolean,
  actorEmail: string | null,
  resumeStep: string | null = null,
): Promise<ImportJob | null> {
  await ensureImportJobsTable();
  const res = await exec(
    `update admin.import_jobs set
       paused = $2,
       paused_by = case when $2 then $3 else null end,
       paused_at = case when $2 then now() else null end,
       resume_step = $4,
       updated_at = now()
     where id = $1
     returning *`,
    [jobId, paused, actorEmail ?? null, resumeStep],
    true,
  );
  const rows = (res.rows ?? []) as Record<string, unknown>[];
  return rows.length ? rowToJob(rows[0]) : null;
}
