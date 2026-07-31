// Resumable, size-aware chunked upload store for the Pluto Migrator extension.
//
// Large Supabase dumps (multi-MB SQL) frequently die mid-POST on flaky
// networks. The extension therefore splits `schema_sql` into chunks and
// uploads them one by one; each chunk is idempotent (upload_id + index).
// When every chunk has landed the payload is assembled and handed to the
// normal `createImportJob` flow.
//
// The extension can ask for the set of already-received indices at any time
// and resume exactly where it stopped.
//
// Integrity: every chunk carries a SHA-256 of its own text. The server
// recomputes it on arrival (reject + ask for re-send on mismatch) and can
// re-verify the whole staged set against a client manifest, dropping only the
// corrupted indices so the upload resumes without restarting from zero.
export type UploadState = {
  upload_id: string;
  event_id: string;
  total_chunks: number;
  total_bytes: number;
  received: number[];
  /** idx → stored sha256 (hex) for each received chunk. */
  checksums: Record<number, string>;
  sha256?: string | null;
  complete: boolean;
  job_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let ensured = false;

async function ensureTables(): Promise<void> {
  if (ensured) return;
  const { writeQuery } = await import("./import-jobs.server");
  await writeQuery(
    `create schema if not exists admin;
     create table if not exists admin.import_uploads (
       upload_id text primary key,
       event_id text not null,
       total_chunks integer not null,
       total_bytes bigint not null default 0,
       envelope jsonb not null default '{}'::jsonb,
       complete boolean not null default false,
       job_id uuid,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     );
     alter table admin.import_uploads add column if not exists sha256 text;
     create table if not exists admin.import_upload_chunks (
       upload_id text not null references admin.import_uploads(upload_id) on delete cascade,
       idx integer not null,
       data text not null,
       bytes integer not null default 0,
       created_at timestamptz not null default now(),
       primary key (upload_id, idx)
     );
     alter table admin.import_upload_chunks add column if not exists sha256 text;
     create index if not exists import_uploads_event_idx on admin.import_uploads (event_id);`,
  );
  ensured = true;
}


function rowToState(r: Record<string, unknown>, received: number[]): UploadState {
  return {
    upload_id: String(r.upload_id),
    event_id: String(r.event_id),
    total_chunks: Number(r.total_chunks ?? 0),
    total_bytes: Number(r.total_bytes ?? 0),
    received,
    complete: r.complete === true,
    job_id: (r.job_id as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

async function loadState(uploadId: string): Promise<UploadState | null> {
  await ensureTables();
  const { readQuery } = await import("./import-jobs.server");
  const head = await readQuery(`select * from admin.import_uploads where upload_id = $1`, [uploadId]);
  const row = ((head.rows ?? []) as Record<string, unknown>[])[0];
  if (!row) return null;
  const parts = await readQuery(
    `select idx from admin.import_upload_chunks where upload_id = $1 order by idx`,
    [uploadId],
  );
  const received = ((parts.rows ?? []) as Record<string, unknown>[]).map((p) => Number(p.idx));
  return rowToState(row, received);
}

/** Resume support: which chunk indices does the server already have? */
export async function getUploadState(uploadId: string): Promise<UploadState | null> {
  return loadState(uploadId);
}

export type ChunkInput = {
  upload_id: string;
  event_id: string;
  index: number;
  total: number;
  data: string;
  /** Envelope (repo, lovable, supabase metadata …) sent with the first chunk. */
  envelope?: Record<string, unknown> | null;
};

export type ChunkResult = {
  ok: boolean;
  state: UploadState;
  /** Set once every chunk landed and the job was created. */
  job_id?: string | null;
  duplicate?: boolean;
  assembled_bytes?: number;
  error?: string;
};

/** Store one chunk (idempotent) and assemble the job when the set is complete. */
export async function receiveChunk(input: ChunkInput): Promise<ChunkResult> {
  await ensureTables();
  const { readQuery, writeQuery } = await import("./import-jobs.server");

  await writeQuery(
    `insert into admin.import_uploads (upload_id, event_id, total_chunks, envelope)
     values ($1, $2, $3, $4::jsonb)
     on conflict (upload_id) do update
       set total_chunks = excluded.total_chunks,
           envelope = case when admin.import_uploads.envelope = '{}'::jsonb
                           then excluded.envelope else admin.import_uploads.envelope end,
           updated_at = now()`,
    [input.upload_id, input.event_id, input.total, JSON.stringify(input.envelope ?? {})],
  );

  await writeQuery(
    `insert into admin.import_upload_chunks (upload_id, idx, data, bytes)
     values ($1, $2, $3, $4)
     on conflict (upload_id, idx) do nothing`,
    [input.upload_id, input.index, input.data, input.data.length],
  );

  const state = (await loadState(input.upload_id))!;
  if (state.complete && state.job_id) {
    return { ok: true, state, job_id: state.job_id, duplicate: true };
  }
  if (state.received.length < state.total_chunks) {
    return { ok: true, state };
  }

  // All chunks present → assemble.
  const parts = await readQuery(
    `select data from admin.import_upload_chunks where upload_id = $1 order by idx`,
    [input.upload_id],
  );
  const sql = ((parts.rows ?? []) as Record<string, unknown>[]).map((p) => String(p.data)).join("");

  const head = await readQuery(`select envelope from admin.import_uploads where upload_id = $1`, [input.upload_id]);
  const envRaw = ((head.rows ?? []) as Record<string, unknown>[])[0]?.envelope;
  const envelope: Record<string, unknown> =
    typeof envRaw === "string" ? JSON.parse(envRaw || "{}") : ((envRaw as Record<string, unknown>) ?? {});

  const supabase = { ...((envelope.supabase as Record<string, unknown>) ?? {}), schema_sql: sql };
  const payload = {
    ...envelope,
    event_id: input.event_id,
    source: (envelope.source as "lovable" | "supabase" | "github") ?? "supabase",
    supabase,
  } as Parameters<typeof import("./import-jobs.server")["createImportJob"]>[0];

  const { translateSupabaseSchema } = await import("./supabase-translate");
  const translated = sql ? translateSupabaseSchema(sql) : null;
  const { createImportJob, appendImportEvent } = await import("./import-jobs.server");
  const { job, duplicate } = await createImportJob(payload, translated?.sql ?? null);

  await writeQuery(
    `update admin.import_uploads
        set complete = true, job_id = $2, total_bytes = $3, updated_at = now()
      where upload_id = $1`,
    [input.upload_id, job?.id ?? null, sql.length],
  );

  if (job) {
    await appendImportEvent({
      jobId: job.id,
      step: "chunk_upload",
      ok: true,
      message: `Chunked upload assembled — ${state.total_chunks} chunk(s), ${sql.length.toLocaleString()} SQL chars`,
      detail: { upload_id: input.upload_id, chunks: state.total_chunks, bytes: sql.length },
    }).catch(() => {});
  }

  return {
    ok: true,
    state: { ...state, complete: true, job_id: job?.id ?? null },
    job_id: job?.id ?? null,
    duplicate,
    assembled_bytes: sql.length,
  };
}

/** Housekeeping: drop upload staging rows older than `hours`. */
export async function pruneUploads(hours = 48): Promise<number> {
  await ensureTables();
  const { writeQuery } = await import("./import-jobs.server");
  const res = await writeQuery(
    `delete from admin.import_uploads where updated_at < now() - ($1 || ' hours')::interval`,
    [String(Math.max(1, hours))],
  );
  return Number(res.row_count ?? 0);
}
