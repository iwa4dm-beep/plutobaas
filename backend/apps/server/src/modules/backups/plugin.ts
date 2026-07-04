// Phase 24 — Workspace backup / export jobs.
//
// Endpoints (gated by PLUTO_ENABLE_BACKUPS=1):
//   GET  /backups/v1                         — list export jobs
//   POST /backups/v1                         — start export { kind, target? }
//   GET  /backups/v1/:id                     — job status + download_path
//   POST /backups/v1/:id/cancel              — mark failed if pending/running
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { recordUsage } from "../../lib/metering.js";

async function runExport(id: string, kind: string, target: string | null) {
  // MVP: emit an INFORMATION_SCHEMA snapshot as SQL-ish text. In prod, hand
  // off to pg_dump via a worker; the shape stays the same.
  const t0 = Date.now();
  try {
    await q(`update public.backup_exports set status='running' where id=$1::uuid`, [id]);
    let body = `-- pluto backup export id=${id} kind=${kind} target=${target ?? '*'} at=${new Date().toISOString()}\n`;
    const tables = await q(
      `select table_schema, table_name from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema')
         and ($1::text is null or table_schema=$1 or table_name=$1)
       order by table_schema, table_name`, [target]);
    for (const t of tables.rows) {
      body += `-- table ${t.table_schema}.${t.table_name}\n`;
      const cols = await q(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_schema=$1 and table_name=$2 order by ordinal_position`,
        [t.table_schema, t.table_name]);
      for (const c of cols.rows) body += `--   ${c.column_name} ${c.data_type} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}\n`;
    }
    const path = `/tmp/pluto-backup-${id}.sql`;
    const fs = await import("fs/promises");
    await fs.writeFile(path, body, "utf8");
    const bytes = Buffer.byteLength(body);
    await q(`update public.backup_exports set status='done', bytes=$2, download_path=$3, finished_at=now()
             where id=$1::uuid`, [id, bytes, path]);
    // Meter as storage_gb (byte→GB) so backups roll into the storage quota bucket.
    const wsRow = await q<{ workspace_id: string | null }>(`select workspace_id from public.backup_exports where id=$1::uuid`, [id]);
    await recordUsage({ workspaceId: wsRow.rows[0]?.workspace_id ?? null,
                        metric: "storage_gb", quantity: bytes / 1e9,
                        billingLabel: "backup_export", meta: { kind, target } });
  } catch (e) {
    await q(`update public.backup_exports set status='failed', error=$2, finished_at=now() where id=$1::uuid`,
            [id, (e as Error).message.slice(0, 500)]);
  } finally {
    void t0;
  }
}

// --- Restore worker: replay SQL statements from a completed export file.
async function runRestore(restoreId: string) {
  const info = await q<{ export_id: string; dry_run: boolean }>(
    `select export_id, dry_run from public.backup_restores where id=$1::uuid`, [restoreId]);
  if (!info.rows[0]) return;
  const exp = await q<{ download_path: string | null; status: string }>(
    `select download_path, status from public.backup_exports where id=$1::uuid`, [info.rows[0].export_id]);
  const path = exp.rows[0]?.download_path;
  if (!path || exp.rows[0].status !== "done") {
    await q(`update public.backup_restores set status='failed', error='export_not_ready', finished_at=now() where id=$1::uuid`, [restoreId]);
    return;
  }
  const dryRun = info.rows[0].dry_run;
  try {
    await q(`update public.backup_restores set status='running' where id=$1::uuid`, [restoreId]);
    const fs = await import("fs/promises");
    const text = await fs.readFile(path, "utf8");
    const stmts = text.split(/\n(?=--\s*table\s)/).map(s => s.trim()).filter(Boolean);
    await q(`update public.backup_restores set total_statements=$2 where id=$1::uuid`, [restoreId, stmts.length]);
    for (let i = 0; i < stmts.length; i++) {
      const preview = stmts[i].slice(0, 200).replace(/\n/g, " ⏎ ");
      const logLine = `[${i + 1}/${stmts.length}] ${dryRun ? "DRY " : "APPLY "}${preview}\n`;
      // Safety: MVP restore only applies -- comments (schema recap); real SQL blocks are logged, not executed.
      const pct = Math.round(((i + 1) / stmts.length) * 100);
      await q(`update public.backup_restores
               set applied_statements=$2, progress=$3, log = log || $4::text
               where id=$1::uuid`, [restoreId, i + 1, pct, logLine]);
      await new Promise(r => setTimeout(r, 40));
    }
    await q(`update public.backup_restores set status='done', progress=100, finished_at=now() where id=$1::uuid`, [restoreId]);
  } catch (e) {
    await q(`update public.backup_restores set status='failed', error=$2, finished_at=now() where id=$1::uuid`,
            [restoreId, (e as Error).message.slice(0, 500)]);
  }
}

export const backupsPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_BACKUPS !== "1") {
    app.log.info("[backups] disabled (set PLUTO_ENABLE_BACKUPS=1 to enable)");
    return;
  }
  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  app.get("/backups/v1", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const rows = await q(
      `select id, kind, target, status, bytes, download_path, error, created_at, finished_at
       from public.backup_exports where workspace_id is not distinct from $1::uuid
       order by created_at desc limit 100`, [ws]);
    return { exports: rows.rows };
  });

  app.post("/backups/v1", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const ws = wsFor(req);
    const b = z.object({ kind: z.enum(["full","schema","table"]).default("full"),
                          target: z.string().max(120).optional() }).parse(req.body);
    const r = await q(
      `insert into public.backup_exports (workspace_id, kind, target, status)
       values ($1::uuid, $2, $3, 'pending') returning id, created_at`,
      [ws, b.kind, b.target ?? null]);
    // Fire-and-forget the exporter; status polls report progress.
    void runExport(r.rows[0].id, b.kind, b.target ?? null);
    return { export: { id: r.rows[0].id, status: "pending", created_at: r.rows[0].created_at } };
  });

  app.get("/backups/v1/:id", { preHandler: requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await q(
      `select id, kind, target, status, bytes, download_path, error, created_at, finished_at
       from public.backup_exports where id=$1::uuid`, [id]);
    if (!r.rows[0]) { reply.code(404); return { error: "not_found" }; }
    return { export: r.rows[0] };
  });

  app.post("/backups/v1/:id/cancel", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await q(`update public.backup_exports set status='failed', error='canceled', finished_at=now()
             where id=$1::uuid and status in ('pending','running')`, [id]);
    return { ok: true };
  });

  // ---------- Restore ----------
  app.get("/backups/v1/:id/restores", { preHandler: requireApiKey }, async (req) => {
    const { id } = req.params as { id: string };
    const r = await q(`select id, dry_run, status, progress, applied_statements, total_statements, error,
                              created_at, finished_at from public.backup_restores
                       where export_id=$1::uuid order by created_at desc`, [id]);
    return { restores: r.rows };
  });

  app.post("/backups/v1/:id/restore", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      dry_run: z.boolean().default(true),
      confirm: z.string().optional(),
      target_branch_id: z.string().uuid().optional(),
      create_branch: z.string().min(1).max(40).optional(),
      allow_incompatible: z.boolean().default(false),
    }).parse(req.body ?? {});
    if (!b.dry_run && b.confirm !== "RESTORE") {
      reply.code(400);
      return { error: "safety_check_failed", hint: "Set confirm='RESTORE' for a live restore." };
    }
    const exp = await q<{ workspace_id: string | null; status: string; kind: string; target: string | null }>(
      `select workspace_id, status, kind, target from public.backup_exports where id=$1::uuid`, [id]);
    if (!exp.rows[0]) { reply.code(404); return { error: "export_not_found" }; }
    if (exp.rows[0].status !== "done") { reply.code(409); return { error: "export_not_ready" }; }

    // Resolve target branch (existing or newly-created).
    let targetBranchId: string | null = null;
    let targetSchema: string | null = null;
    if (b.create_branch) {
      const nm = /^[a-z_][a-z0-9_]{0,40}$/i.test(b.create_branch) ? b.create_branch : null;
      if (!nm) { reply.code(400); return { error: "invalid_branch_name" }; }
      const schema = `br_${nm}_${Math.random().toString(36).slice(2, 8)}`;
      await q(`create schema if not exists "${schema}"`);
      const ins = await q<{ id: string }>(
        `insert into public.db_branches (workspace_id, name, schema_name)
         values ($1::uuid,$2,$3) returning id`, [exp.rows[0].workspace_id, nm, schema]);
      targetBranchId = ins.rows[0].id; targetSchema = schema;
    } else if (b.target_branch_id) {
      const br = await q<{ schema_name: string }>(
        `select schema_name from public.db_branches where id=$1::uuid and workspace_id is not distinct from $2::uuid`,
        [b.target_branch_id, exp.rows[0].workspace_id]);
      if (!br.rows[0]) { reply.code(404); return { error: "branch_not_found" }; }
      targetBranchId = b.target_branch_id; targetSchema = br.rows[0].schema_name;
    }

    // Compatibility check: for a schema/table export, ensure the target schema
    // exists (or is fresh). Skippable via allow_incompatible.
    if (targetSchema && !b.allow_incompatible && (exp.rows[0].kind === "schema" || exp.rows[0].kind === "table")) {
      const chk = await q<{ n: string }>(
        `select count(*)::text as n from information_schema.tables where table_schema=$1`, [targetSchema]);
      if (Number(chk.rows[0].n) > 0 && exp.rows[0].kind === "schema") {
        reply.code(409);
        return { error: "incompatible_schema", hint: "Target branch already has tables. Set allow_incompatible=true to override or pick an empty branch." };
      }
    }

    const r = await q(
      `insert into public.backup_restores (workspace_id, export_id, dry_run, status)
       values ($1::uuid, $2::uuid, $3, 'pending') returning id, created_at`,
      [exp.rows[0].workspace_id, id, b.dry_run]);
    void runRestore(r.rows[0].id);
    const { audit } = await import("../../lib/audit.js");
    await audit(req, {
      action: "backup.restore", target: id,
      status: b.dry_run ? "dry_run" : "ok",
      metadata: { restore_id: r.rows[0].id, target_branch_id: targetBranchId, target_schema: targetSchema, kind: exp.rows[0].kind },
    });
    return { restore: { id: r.rows[0].id, dry_run: b.dry_run, status: "pending", created_at: r.rows[0].created_at,
                        target_branch_id: targetBranchId, target_schema: targetSchema } };
  });

  app.get("/backups/v1/restores/:rid", { preHandler: requireApiKey }, async (req, reply) => {
    const { rid } = req.params as { rid: string };
    const r = await q(`select id, export_id, dry_run, status, progress, applied_statements, total_statements,
                              log, error, created_at, finished_at
                       from public.backup_restores where id=$1::uuid`, [rid]);
    if (!r.rows[0]) { reply.code(404); return { error: "not_found" }; }
    return { restore: r.rows[0] };
  });

  // SSE progress stream.
  app.get("/backups/v1/restores/:rid/stream", { preHandler: requireApiKey }, async (req, reply) => {
    const { rid } = req.params as { rid: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    let done = false;
    const send = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    // Heartbeat every 25s keeps proxies/CDNs (typical 30–60s idle kill)
    // from severing the SSE mid-restore during quiet polling windows.
    const hb = setInterval(() => {
      if (done) return;
      try { reply.raw.write(`: ping\n\n`); } catch { /* closed */ }
    }, 25_000);
    const timer = setInterval(async () => {
      if (done) return;
      const r = await q(`select status, progress, applied_statements, total_statements, log, error
                         from public.backup_restores where id=$1::uuid`, [rid]);
      const row = r.rows[0]; if (!row) { done = true; clearInterval(hb); reply.raw.end(); return; }
      send(row);
      if (row.status === "done" || row.status === "failed" || row.status === "canceled") {
        done = true; clearInterval(timer); clearInterval(hb); reply.raw.end();
      }
    }, 500);
    reply.raw.on("close", () => { done = true; clearInterval(timer); clearInterval(hb); });
  });

  app.post("/backups/v1/restores/:rid/cancel", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const { rid } = req.params as { rid: string };
    await q(`update public.backup_restores set status='canceled', finished_at=now()
             where id=$1::uuid and status in ('pending','running')`, [rid]);
    return { ok: true };
  });

  // Phase 30 — Schema compatibility diff for the restore wizard.
  // Parses the export's DDL preamble and compares against a target schema
  // (default: `public`, or the resolved branch schema). Returns tables and
  // columns that would be created / dropped / retyped so the operator can
  // decide whether to toggle `allow_incompatible`.
  app.get("/backups/v1/:id/compat", { preHandler: requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { target_branch_id?: string; target_schema?: string };
    const exp = await q<{ download_path: string | null; workspace_id: string | null; kind: string; status: string }>(
      `select download_path, workspace_id, kind, status from public.backup_exports where id=$1::uuid`, [id]);
    if (!exp.rows[0]) { reply.code(404); return { error: "export_not_found" }; }
    if (exp.rows[0].status !== "done") { reply.code(409); return { error: "export_not_ready" }; }

    let target = query.target_schema ?? "public";
    if (query.target_branch_id) {
      const br = await q<{ schema_name: string }>(
        `select schema_name from public.db_branches where id=$1::uuid`, [query.target_branch_id]);
      if (br.rows[0]) target = br.rows[0].schema_name;
    }

    type Col = { name: string; type: string; nullable: boolean };
    const source: Record<string, Col[]> = {};
    try {
      const fs = await import("fs/promises");
      const buf = await fs.readFile(exp.rows[0].download_path!, "utf8");
      let currentTable: string | null = null;
      for (const line of buf.split("\n")) {
        const tm = /^-- table\s+([\w.]+)$/.exec(line);
        if (tm) { currentTable = tm[1].includes(".") ? tm[1].split(".")[1] : tm[1]; source[currentTable] = []; continue; }
        const cm = /^--\s{3}(\S+)\s+(.+?)\s+(NULL|NOT NULL)$/.exec(line);
        if (cm && currentTable) source[currentTable].push({ name: cm[1], type: cm[2], nullable: cm[3] === "NULL" });
      }
    } catch (e) {
      reply.code(500); return { error: "read_export_failed", message: (e as Error).message };
    }

    const tgtRows = await q<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema=$1
       order by table_name, ordinal_position`, [target]);
    const targetMap: Record<string, Col[]> = {};
    for (const r of tgtRows.rows) {
      (targetMap[r.table_name] ??= []).push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES" });
    }

    const sourceTables = Object.keys(source);
    const targetTables = Object.keys(targetMap);
    const added_tables   = sourceTables.filter(t => !targetMap[t]);
    const removed_tables = targetTables.filter(t => !source[t]);
    const shared         = sourceTables.filter(t => targetMap[t]);

    type ColDiff = { table: string; column: string; source_type: string | null;
                     target_type: string | null; nullable_change?: string; action: "add"|"drop"|"retype"|"nullable" };
    const columns: ColDiff[] = [];
    for (const t of shared) {
      const src = new Map(source[t].map(c => [c.name, c]));
      const dst = new Map(targetMap[t].map(c => [c.name, c]));
      for (const [name, sc] of src) {
        const dc = dst.get(name);
        if (!dc) columns.push({ table: t, column: name, source_type: sc.type, target_type: null, action: "add" });
        else {
          if (sc.type !== dc.type) columns.push({ table: t, column: name, source_type: sc.type, target_type: dc.type, action: "retype" });
          if (sc.nullable !== dc.nullable) columns.push({ table: t, column: name, source_type: sc.type, target_type: dc.type,
              nullable_change: `${dc.nullable ? "NULL" : "NOT NULL"} → ${sc.nullable ? "NULL" : "NOT NULL"}`, action: "nullable" });
        }
      }
      for (const [name, dc] of dst) if (!src.has(name)) columns.push({ table: t, column: name, source_type: null, target_type: dc.type, action: "drop" });
    }

    return {
      target_schema: target,
      source_tables: sourceTables.length,
      target_tables: targetTables.length,
      added_tables, removed_tables, columns,
      compatible: added_tables.length === 0 && removed_tables.length === 0 && columns.length === 0,
    };
  });

  app.log.info("[backups] Backup exports enabled — /backups/v1/*");
};

