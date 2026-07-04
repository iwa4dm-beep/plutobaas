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
    await q(`update public.backup_exports set status='done', bytes=$2, download_path=$3, finished_at=now()
             where id=$1::uuid`, [id, Buffer.byteLength(body), path]);
  } catch (e) {
    await q(`update public.backup_exports set status='failed', error=$2, finished_at=now() where id=$1::uuid`,
            [id, (e as Error).message.slice(0, 500)]);
  } finally {
    void t0;
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

  app.log.info("[backups] Backup exports enabled — /backups/v1/*");
};
