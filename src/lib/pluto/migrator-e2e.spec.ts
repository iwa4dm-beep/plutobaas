// End-to-end exercise of the Pluto Migrator pipeline.
//
// Covers the whole path the Chrome extension drives:
//   sign → POST /api/public/pluto-import → (chunked or single) → translate →
//   job created → diff → rollback plan → status/verify endpoint.
//
// The Postgres layer (`import-jobs.server`) is replaced with a tiny in-memory
// engine so the test is hermetic; every other module is the real one.
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ---------------------- in-memory SQL substitute ---------------------- */

type Row = Record<string, unknown>;
const uploads = new Map<string, Row>();
const chunks = new Map<string, Map<number, Row>>();
const jobs: Row[] = [];
const events: Row[] = [];

function chunkMap(id: string) {
  if (!chunks.has(id)) chunks.set(id, new Map());
  return chunks.get(id)!;
}

async function run(sql: string, p: unknown[] = []) {
  const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (s.startsWith("create schema")) return { ok: true, rows: [] };
  if (s.startsWith("insert into admin.import_uploads")) {
    const id = String(p[0]);
    const prev = uploads.get(id);
    uploads.set(id, {
      upload_id: id,
      event_id: p[1],
      total_chunks: p[2],
      envelope: p[3],
      sha256: prev?.sha256 ?? p[4] ?? null,
      complete: prev?.complete ?? false,
      job_id: prev?.job_id ?? null,
      total_bytes: prev?.total_bytes ?? 0,
      created_at: prev?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { ok: true, rows: [] };
  }
  if (s.startsWith("insert into admin.import_upload_chunks")) {
    chunkMap(String(p[0])).set(Number(p[1]), { idx: Number(p[1]), data: p[2], bytes: p[3], sha256: p[4] });
    return { ok: true, rows: [] };
  }
  if (s.startsWith("select * from admin.import_uploads")) {
    const r = uploads.get(String(p[0]));
    return { ok: true, rows: r ? [r] : [] };
  }
  if (s.startsWith("select envelope, sha256 from admin.import_uploads")) {
    const r = uploads.get(String(p[0]));
    return { ok: true, rows: r ? [{ envelope: r.envelope, sha256: r.sha256 }] : [] };
  }
  if (s.startsWith("select idx, sha256") || s.startsWith("select idx, data, sha256") || s.startsWith("select data from admin.import_upload_chunks")) {
    const rows = [...chunkMap(String(p[0])).values()].sort((a, b) => Number(a.idx) - Number(b.idx));
    return { ok: true, rows };
  }
  if (s.startsWith("update admin.import_uploads")) {
    const r = uploads.get(String(p[0]));
    if (r) Object.assign(r, { complete: true, job_id: p[1], total_bytes: p[2] });
    return { ok: true, rows: [] };
  }
  if (s.startsWith("delete from admin.import_upload_chunks")) {
    const list = String(p[1]).replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
    for (const i of list) chunkMap(String(p[0])).delete(i);
    return { ok: true, rows: [], row_count: list.length };
  }
  if (s.startsWith("delete from admin.import_uploads")) return { ok: true, rows: [], row_count: 0 };
  return { ok: true, rows: [] };
}

vi.mock("@/lib/pluto/import-jobs.server", () => ({
  readQuery: (sql: string, p?: unknown[]) => run(sql, p),
  writeQuery: (sql: string, p?: unknown[]) => run(sql, p),
  createImportJob: async (payload: Row, migrationSql: string | null) => {
    const dup = jobs.find((j) => j.event_id === payload.event_id);
    if (dup) return { job: dup, duplicate: true };
    const job = {
      id: `job-${jobs.length + 1}`,
      event_id: payload.event_id,
      source: payload.source,
      status: migrationSql ? "translated" : "received",
      repo: payload.repo ?? null,
      migration_sql: migrationSql,
      paused: false,
      applied_at: null,
      applied_by: null,
      selection: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload,
    };
    jobs.push(job);
    return { job, duplicate: false };
  },
  appendImportEvent: async (e: Row) => {
    events.push(e);
  },
  getImportJobById: async (id: string) => jobs.find((j) => j.id === id) ?? null,
  listImportJobs: async () => jobs,
  listImportEvents: async () => events.map((e, i) => ({ ...e, id: String(i), created_at: new Date().toISOString() })),
  listVerificationRuns: async () => [],
}));

/* ------------------------------ helpers ------------------------------ */

const SECRET = "test-migrator-secret";

async function sha256Hex(text: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function signed(url: string, body: unknown, opts: { ts?: number; badSig?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${raw}`));
  const sig = opts.badSig ? "0".repeat(64) : [...new Uint8Array(sigBuf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pluto-timestamp": ts, "x-pluto-signature": `sha256=${sig}` },
    body: raw,
  });
}

type Handler = (ctx: { request: Request }) => Promise<Response>;
async function post(mod: "pluto-import" | "pluto-import-status", req: Request) {
  const m = await import(`@/routes/api/public/${mod}`);
  const h = (m.Route as { options: { server: { handlers: { POST: Handler } } } }).options.server.handlers.POST;
  const res = await h({ request: req });
  return { status: res.status, body: (await res.json()) as Row };
}

const DUMP = `
create schema if not exists public;
create table public.notes (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id),
  title text not null,
  created_at timestamptz default now()
);
alter table public.notes enable row level security;
create policy "own notes" on public.notes for select using (auth.uid() = owner_id);
create view public.recent_notes as select * from public.notes order by created_at desc;
grant select on public.notes to authenticated;
`;

beforeEach(() => {
  uploads.clear();
  chunks.clear();
  jobs.length = 0;
  events.length = 0;
  process.env.PLUTO_IMPORT_WEBHOOK_SECRET = SECRET;
});

/* ------------------------------- tests ------------------------------- */

describe("Migrator — ingest security", () => {
  it("rejects unsigned, stale and forged requests; 503 without a secret", async () => {
    const unsigned = new Request("http://localhost/api/public/pluto-import", {
      method: "POST",
      body: JSON.stringify({ event_id: "abcdefgh", source: "supabase" }),
    });
    expect((await post("pluto-import", unsigned)).status).toBe(401);

    const stale = await signed("/api/public/pluto-import", { event_id: "abcdefgh", source: "supabase" }, { ts: Math.floor(Date.now() / 1000) - 4000 });
    expect((await post("pluto-import", stale)).status).toBe(401);

    const forged = await signed("/api/public/pluto-import", { event_id: "abcdefgh", source: "supabase" }, { badSig: true });
    const f = await post("pluto-import", forged);
    expect(f.status).toBe(401);
    expect(f.body.error).toBe("invalid_signature");

    delete process.env.PLUTO_IMPORT_WEBHOOK_SECRET;
    const ok = await signed("/api/public/pluto-import", { event_id: "abcdefgh", source: "supabase" });
    expect((await post("pluto-import", ok)).status).toBe(503);
  });
});

describe("Migrator — single-shot import", () => {
  it("translates a Supabase dump, creates a job, and is replay-safe", async () => {
    const payload = { event_id: "evt-single-1", source: "supabase", supabase: { ref: "abcd", schema_sql: DUMP } };
    const first = await post("pluto-import", await signed("/api/public/pluto-import", payload));
    expect(first.status).toBe(202);
    expect(first.body.job_id).toBeTruthy();
    expect(first.body.translation).toBeTruthy();

    const again = await post("pluto-import", await signed("/api/public/pluto-import", payload));
    expect(again.body.duplicate).toBe(true);
    expect(jobs).toHaveLength(1);
  });
});

describe("Migrator — resumable chunked upload with checksums", () => {
  it("assembles clean chunks into one job", async () => {
    const parts = [DUMP.slice(0, 120), DUMP.slice(120, 260), DUMP.slice(260)];
    const full = await sha256Hex(parts.join(""));
    let last: Row = {};
    for (let i = 0; i < parts.length; i++) {
      const r = await post(
        "pluto-import",
        await signed("/api/public/pluto-import", {
          event_id: "evt-chunk-ok",
          chunk: { upload_id: "up-ok-123456", index: i, total: parts.length, data: parts[i], sha256: await sha256Hex(parts[i]), full_sha256: full },
          envelope: { source: "supabase", supabase: { ref: "abcd" } },
        }),
      );
      last = r.body;
    }
    expect(last.job_id).toBeTruthy();
    expect(jobs[0].migration_sql).toContain("notes");
  });

  it("rejects a corrupted chunk with 422 and re-requests only that index", async () => {
    const parts = ["create table a (id int);", "create table b (id int);"];
    const good0 = await sha256Hex(parts[0]);
    const bad = await post(
      "pluto-import",
      await signed("/api/public/pluto-import", {
        event_id: "evt-chunk-bad",
        chunk: { upload_id: "up-bad-123456", index: 0, total: 2, data: "TAMPERED", sha256: good0 },
      }),
    );
    expect(bad.status).toBe(422);
    expect(bad.body.corrupt).toEqual([0]);

    // Re-send the good bytes, then the rest → job completes.
    for (let i = 0; i < parts.length; i++) {
      await post(
        "pluto-import",
        await signed("/api/public/pluto-import", {
          event_id: "evt-chunk-bad",
          chunk: { upload_id: "up-bad-123456", index: i, total: 2, data: parts[i], sha256: await sha256Hex(parts[i]) },
        }),
      );
    }
    expect(jobs.some((j) => j.event_id === "evt-chunk-bad")).toBe(true);
  });

  it("upload_status + verify_upload report resume state", async () => {
    await post(
      "pluto-import",
      await signed("/api/public/pluto-import", {
        event_id: "evt-resume-1",
        chunk: { upload_id: "up-res-123456", index: 0, total: 3, data: "select 1;", sha256: await sha256Hex("select 1;") },
      }),
    );
    const st = await post("pluto-import-status", await signed("/api/public/pluto-import-status", { action: "upload_status", upload_id: "up-res-123456" }));
    expect(st.status).toBe(200);
    expect((st.body.state as Row).received).toEqual([0]);

    const vf = await post(
      "pluto-import-status",
      await signed("/api/public/pluto-import-status", { action: "verify_upload", upload_id: "up-res-123456", manifest: { "0": "f".repeat(64) } }),
    );
    expect(vf.body.corrupt).toEqual([0]);
    expect(vf.body.missing).toEqual([0, 1, 2]);
  });
});

describe("Migrator — translate → diff → rollback", () => {
  it("produces a reviewable diff and an invertible rollback plan", async () => {
    const { translateSupabaseSchema } = await import("./supabase-translate");
    const { diffSql } = await import("./sql-diff");
    const { buildRollbackPlan } = await import("./sql-rollback");
    const { inventoryDump, filterDumpBySelection } = await import("./supabase-objects");

    const t = translateSupabaseSchema(DUMP);
    expect(t.sql.length).toBeGreaterThan(0);

    const d = diffSql(t.sql);
    expect(d.entries.length).toBeGreaterThan(3);
    expect(d.counts.create).toBeGreaterThan(0);

    const plan = buildRollbackPlan(t.sql);
    expect(plan.sql).toMatch(/drop table if exists/i);
    expect(plan.entries.some((e) => e.objectType === "view")).toBe(true);

    const inv = inventoryDump(DUMP);
    expect(inv.some((o) => o.kind === "table")).toBe(true);
    const only = filterDumpBySelection(DUMP, inv.filter((o) => o.kind === "table").map((o) => o.key));
    expect(only).toContain("notes");
  });
});

describe("Migrator — status endpoint", () => {
  it("returns job + timeline events for a completed import", async () => {
    await post(
      "pluto-import",
      await signed("/api/public/pluto-import", { event_id: "evt-status-1", source: "supabase", supabase: { schema_sql: DUMP } }),
    );
    const jobId = String(jobs[0].id);
    const r = await post("pluto-import-status", await signed("/api/public/pluto-import-status", { action: "status", job_id: jobId }));
    expect(r.status).toBe(200);
    expect((r.body.job as Row).id).toBe(jobId);
    expect(Array.isArray(r.body.events)).toBe(true);
  });
});
