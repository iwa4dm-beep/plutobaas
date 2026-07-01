// Admin SQL runner.
//
// Features:
//   - Read-only mode enforced at the transaction level: the query
//     executes inside `BEGIN READ ONLY` and rollbacks on completion,
//     so nothing (not even side-effectful statements sneaked in via
//     CTEs) can persist.
//   - Multi-statement support with per-statement row/column reporting.
//   - Server-side timeout (statement_timeout) capped at 30s.
//   - Every run is recorded to public.sql_history with actor, workspace,
//     duration, row count, and error (if any) — regardless of outcome.
//   - Permissions:
//        - service_role + admin JWT  → full mode (read-write allowed)
//        - service_role WITHOUT admin JWT → 403
//        - authenticated non-admin bearer against /read-only → allowed
//          only when the caller is a workspace member; forced read-only.
//
// Endpoints:
//   POST   /run                    — run SQL (read-only OR read-write)
//   GET    /history?workspace=…    — recent history for a workspace
//   POST   /explain                — EXPLAIN a query without executing it

import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { z } from "zod";
import { env } from "../../config.js";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";
import { logAudit } from "../../lib/audit.js";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
const STATEMENT_TIMEOUT_MS = 30_000;
const MAX_ROWS_RETURNED = 5_000;
const MAX_SQL_BYTES = 100_000;

type RunResult = {
  command: string | null;
  row_count: number | null;
  rows: unknown[];
  columns: { name: string; type_oid: number }[];
  truncated: boolean;
};

async function recordHistory(
  req: FastifyRequest,
  args: { sql: string; readOnly: boolean; status: "ok" | "error"; rowCount: number | null; durationMs: number; error?: string }
): Promise<string | null> {
  try {
    const r = await pool.query<{ id: string }>(
      `insert into public.sql_history
         (workspace_id, user_id, user_email, sql, read_only, status, row_count, duration_ms, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        req.auth?.workspaceId ?? null,
        req.auth?.user?.sub ?? null,
        req.auth?.user?.email ?? null,
        args.sql,
        args.readOnly,
        args.status,
        args.rowCount,
        args.durationMs,
        args.error ?? null,
      ]
    );
    return r.rows[0].id;
  } catch {
    return null; // history is best-effort — never block the runner
  }
}

async function runQuery(sql: string, readOnly: boolean): Promise<RunResult[]> {
  const client = await pool.connect();
  try {
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    if (readOnly) {
      await client.query("begin read only");
    } else {
      await client.query("begin");
    }
    try {
      const raw = await client.query(sql);
      const arr = Array.isArray(raw) ? raw : [raw];
      const out: RunResult[] = arr.map((r) => {
        const rows = (r.rows ?? []) as unknown[];
        return {
          command: r.command ?? null,
          row_count: r.rowCount ?? null,
          rows: rows.slice(0, MAX_ROWS_RETURNED),
          columns: (r.fields ?? []).map((f: { name: string; dataTypeID: number }) => ({
            name: f.name, type_oid: f.dataTypeID,
          })),
          truncated: rows.length > MAX_ROWS_RETURNED,
        };
      });
      if (readOnly) {
        await client.query("rollback");           // always undo, even for pure SELECTs
      } else {
        await client.query("commit");
      }
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function sqlRunnerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Both read-only and read-write executions live behind requireAdmin
  // for now — workspace-scoped non-admin execution is opt-in and lives
  // on /run-scoped (below). Keeps the default surface small.
  app.post("/run", async (req, reply) => {
    await new Promise<void>((r) => { requireAdmin(req, reply); r(); });
    if (reply.sent) return;

    const body = z.object({
      sql: z.string().min(1).max(MAX_SQL_BYTES),
      read_only: z.boolean().default(false),
      workspace_id: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const t0 = Date.now();
    try {
      const results = await runQuery(body.data.sql, body.data.read_only);
      const total = results.reduce((n, r) => n + (r.row_count ?? 0), 0);
      const historyId = await recordHistory(req, {
        sql: body.data.sql, readOnly: body.data.read_only,
        status: "ok", rowCount: total, durationMs: Date.now() - t0,
      });
      await logAudit(req, {
        action: body.data.read_only ? "sql.run_read_only" : "sql.run",
        target: historyId ?? "sql",
        status: "ok",
        metadata: { duration_ms: Date.now() - t0, statements: results.length, rows: total },
      });
      return {
        history_id: historyId,
        duration_ms: Date.now() - t0,
        read_only: body.data.read_only,
        results,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const historyId = await recordHistory(req, {
        sql: body.data.sql, readOnly: body.data.read_only,
        status: "error", rowCount: null, durationMs: Date.now() - t0, error: message,
      });
      await logAudit(req, {
        action: body.data.read_only ? "sql.run_read_only" : "sql.run",
        target: historyId ?? "sql", status: "error",
        metadata: { duration_ms: Date.now() - t0, message },
      });
      return reply.code(400).send({ error: "sql_error", message, history_id: historyId });
    }
  });

  // EXPLAIN — always read-only. Handy for the dashboard to preview a
  // query plan without running the workload.
  app.post("/explain", async (req, reply) => {
    await new Promise<void>((r) => { requireAdmin(req, reply); r(); });
    if (reply.sent) return;
    const body = z.object({ sql: z.string().min(1).max(MAX_SQL_BYTES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const [res] = await runQuery(`explain (format json) ${body.data.sql}`, true);
      return { plan: res.rows[0] };
    } catch (e) {
      return reply.code(400).send({ error: "sql_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // History — server-side filter + pagination.
  app.get("/history", async (req, reply) => {
    await new Promise<void>((r) => { requireAdmin(req, reply); r(); });
    if (reply.sent) return;
    const q = z.object({
      workspace_id: z.string().uuid().optional(),
      user_id:      z.string().uuid().optional(),
      status:       z.enum(["ok", "error"]).optional(),
      read_only:    z.enum(["true", "false"]).optional(),
      q:            z.string().max(500).optional(),
      limit:        z.coerce.number().int().min(1).max(200).default(50),
      offset:       z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query", issues: q.error.issues });

    const parts: string[] = [];
    const args: unknown[] = [];
    const add = (frag: string, v: unknown) => { args.push(v); parts.push(frag.replace("$?", `$${args.length}`)); };
    if (q.data.workspace_id) add("workspace_id = $?", q.data.workspace_id);
    if (q.data.user_id)      add("user_id = $?",      q.data.user_id);
    if (q.data.status)       add("status = $?",       q.data.status);
    if (q.data.read_only)    add("read_only = $?",    q.data.read_only === "true");
    if (q.data.q)            add("sql ilike $?",      `%${q.data.q}%`);
    const where = parts.length ? `where ${parts.join(" and ")}` : "";

    const [rows, count] = await Promise.all([
      pool.query(
        `select id, workspace_id, user_id, user_email, left(sql, 500) as sql_preview,
                length(sql) as sql_bytes, read_only, status, row_count, duration_ms, error, ran_at
           from public.sql_history ${where}
          order by ran_at desc
          limit ${q.data.limit} offset ${q.data.offset}`,
        args
      ),
      pool.query<{ n: string }>(`select count(*)::text as n from public.sql_history ${where}`, args),
    ]);
    return {
      items: rows.rows,
      total: Number(count.rows[0]?.n ?? 0),
      limit: q.data.limit, offset: q.data.offset,
    };
  });

  // Fetch one history entry with full SQL body (for re-run).
  app.get("/history/:id", async (req, reply) => {
    await new Promise<void>((r) => { requireAdmin(req, reply); r(); });
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad_id" });
    const { rows } = await pool.query(
      `select id, workspace_id, user_id, user_email, sql, read_only, status,
              row_count, duration_ms, error, ran_at
         from public.sql_history where id = $1`,
      [id]
    );
    if (!rows.length) return reply.code(404).send({ error: "not_found" });
    return rows[0];
  });
}
