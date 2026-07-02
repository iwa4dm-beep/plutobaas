// Phase 21 — Database branching MVP, Studio schema editor, and metered usage.
//
// Endpoints (gated by PLUTO_ENABLE_BRANCHING=1 / PLUTO_ENABLE_USAGE=1):
//   GET/POST/DELETE /branches/v1                        — list/create/archive branches
//   POST /branches/v1/:id/apply                         — apply raw SQL inside branch schema
//   GET  /branches/v1/:id/changes                       — statement log
//   POST /schema/v1/apply                               — Studio structured ops → SQL → execute
//   GET  /schema/v1/history                             — audit of schema edits
//   POST /usage/v1/events                               — ingest a metered event
//   GET  /usage/v1/summary                              — aggregates by metric
//   GET/PUT /usage/v1/quotas                            — read/write per-workspace quotas
//
// Branching MVP model: every branch is a Postgres schema. Creating a branch
// snapshots the parent by copying table DDL into the new schema; further
// changes are recorded in db_branch_changes for future diff/PITR tooling.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey } from "../../lib/apikey.js";

const IDENT = /^[a-z_][a-z0-9_]{0,40}$/i;

function safeIdent(name: string, label = "identifier"): string {
  if (!IDENT.test(name)) throw new Error(`invalid ${label}: ${name}`);
  return name;
}

export const branchingPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_BRANCHING !== "1") {
    app.log.info("[branching] disabled (set PLUTO_ENABLE_BRANCHING=1 to enable)");
    return;
  }

  // ------------------------ Branches ---------------------------------
  app.get("/branches/v1", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const rows = await q(
      `select id, name, schema_name, parent_id, status, created_at
       from public.db_branches where workspace_id=$1::uuid order by created_at desc`, [ws]);
    return { branches: rows.rows };
  });

  app.post("/branches/v1", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      name: z.string().min(1).max(40),
      parent_id: z.string().uuid().optional(),
      copy_from: z.string().optional(), // parent schema to clone tables from
    }).parse(req.body);
    const nm = safeIdent(b.name, "branch");
    const schema = `br_${nm}_${Math.random().toString(36).slice(2, 8)}`;
    await q(`create schema ${safeIdent(schema, "schema")}`);
    // Optionally clone parent tables (structure only, MVP)
    if (b.copy_from) {
      const parent = safeIdent(b.copy_from, "parent_schema");
      const tables = await q<{ tablename: string }>(
        `select tablename from pg_tables where schemaname=$1`, [parent]);
      for (const t of tables.rows) {
        const tn = safeIdent(t.tablename, "table");
        await q(`create table ${schema}.${tn} (like ${parent}.${tn} including all)`);
      }
    }
    const ins = await q(
      `insert into public.db_branches (workspace_id, name, schema_name, parent_id)
       values ($1,$2,$3,$4) returning id, name, schema_name, parent_id, status, created_at`,
      [ws, b.name, schema, b.parent_id ?? null]);
    reply.code(201);
    return ins.rows[0];
  });

  app.delete<{ Params: { id: string } }>("/branches/v1/:id",
    { preHandler: requireApiKey }, async (req) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const row = await q<{ schema_name: string }>(
        `select schema_name from public.db_branches where id=$1 and workspace_id=$2::uuid`,
        [req.params.id, ws]);
      if (row.rows[0]) {
        await q(`drop schema if exists ${safeIdent(row.rows[0].schema_name, "schema")} cascade`);
      }
      await q(`delete from public.db_branches where id=$1 and workspace_id=$2::uuid`,
        [req.params.id, ws]);
      return { ok: true };
    });

  app.post<{ Params: { id: string } }>("/branches/v1/:id/apply",
    { preHandler: requireApiKey }, async (req, reply) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const b = z.object({ sql: z.string().min(1).max(50_000) }).parse(req.body);
      const row = await q<{ schema_name: string }>(
        `select schema_name from public.db_branches where id=$1 and workspace_id=$2::uuid`,
        [req.params.id, ws]);
      if (!row.rows[0]) { reply.code(404); return { error: "not_found" }; }
      const schema = safeIdent(row.rows[0].schema_name, "schema");
      let ok = true; let error: string | null = null;
      try {
        await q(`set local search_path = ${schema}, public`);
        await q(b.sql);
      } catch (e) { ok = false; error = (e as Error).message; }
      await q(
        `insert into public.db_branch_changes (branch_id, statement, ok, error)
         values ($1,$2,$3,$4)`, [req.params.id, b.sql, ok, error]);
      if (!ok) { reply.code(400); return { ok, error }; }
      return { ok: true };
    });

  app.get<{ Params: { id: string } }>("/branches/v1/:id/changes",
    { preHandler: requireApiKey }, async (req) => {
      const r = await q(
        `select id, statement, ok, error, applied_at
         from public.db_branch_changes where branch_id=$1 order by applied_at desc limit 200`,
        [req.params.id]);
      return { changes: r.rows };
    });

  // ------------------------ PITR-lite snapshots ------------------------
  // A snapshot is a copy of the branch schema (`snap_<random>`) taken at a
  // moment in time. Restore swaps the branch schema with the snapshot so
  // callers can safely roll back schema changes. This is not real Postgres
  // PITR (WAL replay) but covers 90% of "undo a bad migration" needs.

  async function branchOwned(id: string, ws: string | null): Promise<string | null> {
    const r = await q<{ schema_name: string }>(
      `select schema_name from public.db_branches where id=$1 and workspace_id=$2::uuid`,
      [id, ws]);
    return r.rows[0]?.schema_name ?? null;
  }

  async function cloneSchema(fromSchema: string, toSchema: string): Promise<void> {
    await q(`create schema ${safeIdent(toSchema, "schema")}`);
    const tables = await q<{ tablename: string }>(
      `select tablename from pg_tables where schemaname=$1`, [fromSchema]);
    for (const t of tables.rows) {
      const tn = safeIdent(t.tablename, "table");
      // structure + defaults + constraints + indexes
      await q(`create table ${toSchema}.${tn} (like ${fromSchema}.${tn} including all)`);
      // copy rows so the snapshot captures data, not just DDL
      await q(`insert into ${toSchema}.${tn} select * from ${fromSchema}.${tn}`);
    }
  }

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/branches/v1/:id/snapshots", { preHandler: requireApiKey },
    async (req, reply) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const schema = await branchOwned(req.params.id, ws);
      if (!schema) { reply.code(404); return { error: "not_found" }; }
      const snapSchema = `snap_${Math.random().toString(36).slice(2, 10)}`;
      await cloneSchema(schema, snapSchema);
      const ins = await q(
        `insert into public.db_branch_snapshots (branch_id, workspace_id, snapshot_schema, reason)
         values ($1,$2::uuid,$3,$4)
         returning id, snapshot_schema, reason, created_at, status`,
        [req.params.id, ws, snapSchema, req.body?.reason ?? null]);
      reply.code(201);
      return ins.rows[0];
    });

  app.get<{ Params: { id: string } }>("/branches/v1/:id/snapshots",
    { preHandler: requireApiKey }, async (req) => {
      const r = await q(
        `select id, snapshot_schema, reason, created_at, restored_at, status
         from public.db_branch_snapshots
         where branch_id=$1 order by created_at desc limit 100`, [req.params.id]);
      return { snapshots: r.rows };
    });

  app.post<{ Params: { id: string; snapId: string } }>(
    "/branches/v1/:id/snapshots/:snapId/restore",
    { preHandler: requireApiKey }, async (req, reply) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const branchSchema = await branchOwned(req.params.id, ws);
      if (!branchSchema) { reply.code(404); return { error: "branch_not_found" }; }
      const snap = await q<{ snapshot_schema: string }>(
        `select snapshot_schema from public.db_branch_snapshots
         where id=$1 and branch_id=$2 and workspace_id=$3::uuid and status='ready'`,
        [req.params.snapId, req.params.id, ws]);
      if (!snap.rows[0]) { reply.code(404); return { error: "snapshot_not_found" }; }

      // Take a safety snapshot of the current live schema before we swap.
      const rescue = `snap_${Math.random().toString(36).slice(2, 10)}`;
      await cloneSchema(branchSchema, rescue);
      await q(
        `insert into public.db_branch_snapshots (branch_id, workspace_id, snapshot_schema, reason)
         values ($1,$2::uuid,$3,$4)`,
        [req.params.id, ws, rescue, `pre-restore auto-snapshot of ${branchSchema}`]);

      // Atomic swap: rename live→tmp, snapshot→live, tmp→snapshot-name.
      const tmp = `tmp_${Math.random().toString(36).slice(2, 10)}`;
      await q(`begin`);
      try {
        await q(`alter schema ${safeIdent(branchSchema, "schema")} rename to ${safeIdent(tmp, "schema")}`);
        await q(`alter schema ${safeIdent(snap.rows[0].snapshot_schema, "schema")} rename to ${safeIdent(branchSchema, "schema")}`);
        await q(`alter schema ${safeIdent(tmp, "schema")} rename to ${safeIdent(snap.rows[0].snapshot_schema, "schema")}`);
        await q(`update public.db_branch_snapshots
                 set status='restored', restored_at=now()
                 where id=$1`, [req.params.snapId]);
        await q(`commit`);
      } catch (e) {
        await q(`rollback`);
        reply.code(500);
        return { error: (e as Error).message };
      }
      return { ok: true, restored_from: req.params.snapId, rescue_schema: rescue };
    });

  app.delete<{ Params: { id: string; snapId: string } }>(
    "/branches/v1/:id/snapshots/:snapId",
    { preHandler: requireApiKey }, async (req, reply) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const s = await q<{ snapshot_schema: string }>(
        `select snapshot_schema from public.db_branch_snapshots
         where id=$1 and branch_id=$2 and workspace_id=$3::uuid`,
        [req.params.snapId, req.params.id, ws]);
      if (!s.rows[0]) { reply.code(404); return { error: "not_found" }; }
      await q(`drop schema if exists ${safeIdent(s.rows[0].snapshot_schema, "schema")} cascade`);
      await q(`delete from public.db_branch_snapshots where id=$1`, [req.params.snapId]);
      return { ok: true };
    });


  // ------------------------ Studio schema editor -----------------------
  // Structured ops → deterministic SQL. Kept intentionally small for MVP.
  type Op =
    | { op: "create_table"; schema?: string; table: string;
        columns: Array<{ name: string; type: string; nullable?: boolean; default?: string; primary?: boolean }> }
    | { op: "add_column";   schema?: string; table: string; column: string; type: string; nullable?: boolean; default?: string }
    | { op: "drop_column";  schema?: string; table: string; column: string }
    | { op: "add_index";    schema?: string; table: string; name: string; columns: string[]; unique?: boolean }
    | { op: "add_fk";       schema?: string; table: string; name: string; column: string; ref_table: string; ref_column: string };

  function opToSQL(op: Op): string {
    const s  = safeIdent(op.schema ?? "public", "schema");
    const t  = safeIdent(op.table, "table");
    const fq = `${s}.${t}`;
    switch (op.op) {
      case "create_table": {
        const cols = op.columns.map((c) => {
          const parts = [
            safeIdent(c.name, "column"),
            c.type.replace(/[;]/g, ""),
            c.primary ? "primary key" : "",
            c.nullable === false ? "not null" : "",
            c.default ? `default ${c.default.replace(/[;]/g, "")}` : "",
          ].filter(Boolean);
          return parts.join(" ");
        }).join(", ");
        return `create table if not exists ${fq} (${cols})`;
      }
      case "add_column": {
        const c = safeIdent(op.column, "column");
        return `alter table ${fq} add column ${c} ${op.type.replace(/[;]/g, "")}` +
               (op.nullable === false ? " not null" : "") +
               (op.default ? ` default ${op.default.replace(/[;]/g, "")}` : "");
      }
      case "drop_column":
        return `alter table ${fq} drop column ${safeIdent(op.column, "column")}`;
      case "add_index": {
        const n = safeIdent(op.name, "index");
        const cols = op.columns.map((c) => safeIdent(c, "column")).join(", ");
        return `create ${op.unique ? "unique " : ""}index if not exists ${n} on ${fq} (${cols})`;
      }
      case "add_fk": {
        const n  = safeIdent(op.name, "fk");
        const c  = safeIdent(op.column, "column");
        const rt = safeIdent(op.ref_table, "ref_table");
        const rc = safeIdent(op.ref_column, "ref_column");
        return `alter table ${fq} add constraint ${n} foreign key (${c}) references public.${rt}(${rc})`;
      }
    }
  }

  app.post("/schema/v1/apply", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const b = z.object({
      operations: z.array(z.any()).min(1).max(50),
      branch_id: z.string().uuid().optional(),
      dry_run: z.boolean().optional(),
    }).parse(req.body);

    const statements = (b.operations as Op[]).map((o) => ({ op: o, sql: opToSQL(o) }));
    if (b.dry_run) return { dry_run: true, statements };

    const results: Array<{ sql: string; ok: boolean; error?: string }> = [];
    for (const s of statements) {
      let ok = true; let error: string | undefined;
      try { await q(s.sql); } catch (e) { ok = false; error = (e as Error).message; }
      await q(
        `insert into public.schema_edits (workspace_id, branch_id, operation, sql, ok, error)
         values ($1,$2,$3,$4,$5,$6)`,
        [ws, b.branch_id ?? null, s.op, s.sql, ok, error ?? null]);
      results.push({ sql: s.sql, ok, error });
      if (!ok) break;
    }
    const anyFail = results.some((r) => !r.ok);
    if (anyFail) reply.code(400);
    return { ok: !anyFail, results };
  });

  app.get("/schema/v1/history", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const r = await q(
      `select id, operation, sql, ok, error, applied_at, branch_id
       from public.schema_edits where workspace_id=$1::uuid
       order by applied_at desc limit 200`, [ws]);
    return { edits: r.rows };
  });
};

export const usagePlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_USAGE !== "1") {
    app.log.info("[usage] disabled (set PLUTO_ENABLE_USAGE=1 to enable)");
    return;
  }

  const METRICS = ["storage_gb","egress_gb","function_invocations","ai_tokens","db_rows","realtime_msgs"] as const;
  const ENVS = ["production","preview","development"] as const;

  app.post("/usage/v1/events", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      metric: z.enum(METRICS),
      quantity: z.number().nonnegative(),
      environment: z.enum(ENVS).default("production"),
      billing_label: z.string().max(80).optional(),
      meta: z.record(z.any()).optional(),
    }).parse(req.body);
    const { recordUsage } = await import("../../lib/metering.js");
    const r = await recordUsage({
      workspaceId: ws, metric: b.metric, quantity: b.quantity,
      environment: b.environment, billingLabel: b.billing_label, meta: b.meta,
    });
    if (!r.ok) reply.code(429);
    return r;
  });

  app.post("/usage/v1/check", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({ metric: z.enum(METRICS), quantity: z.number().nonnegative() }).parse(req.body);
    const { checkQuota } = await import("../../lib/metering.js");
    return checkQuota(ws, b.metric, b.quantity);
  });

  app.get("/usage/v1/summary", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const query = req.query as { period?: string; environment?: string };
    const period = (query?.period ?? "month") === "day" ? "1 day" : "30 days";
    const envFilter = query?.environment && ENVS.includes(query.environment as typeof ENVS[number])
      ? query.environment : null;
    const params: unknown[] = [ws];
    let envClause = "";
    if (envFilter) { params.push(envFilter); envClause = ` and environment=$${params.length}`; }
    const usage = await q<{ metric: string; total: string; environment: string; billing_label: string | null }>(
      `select metric, environment, billing_label, sum(quantity)::text as total
       from public.usage_events
       where workspace_id=$1::uuid and observed_at > now() - interval '${period}'${envClause}
       group by metric, environment, billing_label`, params);
    const quotas = await q<{ metric: string; hard_limit: number; soft_limit: number | null; period: string; overage_behavior: string; billing_label: string | null }>(
      `select metric, hard_limit, soft_limit, period, overage_behavior, billing_label
       from public.workspace_quotas where workspace_id=$1::uuid`, [ws]);
    const byMetric: Record<string, {
      used: number; hard_limit: number | null; soft_limit: number | null; pct: number | null;
      overage_behavior: string | null; billing_label: string | null;
      by_env: Record<string, number>; by_label: Record<string, number>;
    }> = {};
    for (const m of METRICS) byMetric[m] = { used: 0, hard_limit: null, soft_limit: null, pct: null, overage_behavior: null, billing_label: null, by_env: {}, by_label: {} };
    for (const r of usage.rows) {
      const b = byMetric[r.metric]; if (!b) continue;
      const n = Number(r.total);
      b.used += n;
      b.by_env[r.environment] = (b.by_env[r.environment] ?? 0) + n;
      if (r.billing_label) b.by_label[r.billing_label] = (b.by_label[r.billing_label] ?? 0) + n;
    }
    for (const qq of quotas.rows) {
      const b = byMetric[qq.metric]; if (!b) continue;
      b.hard_limit = qq.hard_limit; b.soft_limit = qq.soft_limit;
      b.overage_behavior = qq.overage_behavior; b.billing_label = qq.billing_label;
      b.pct = qq.hard_limit > 0 ? Math.min(100, (b.used / qq.hard_limit) * 100) : null;
    }
    return { period, environment: envFilter, metrics: byMetric };
  });

  app.get("/usage/v1/quotas", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const r = await q(
      `select metric, period, hard_limit, soft_limit, overage_behavior, billing_label, updated_at
       from public.workspace_quotas where workspace_id=$1::uuid order by metric`, [ws]);
    return { quotas: r.rows };
  });

  app.put("/usage/v1/quotas", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      metric: z.enum(METRICS),
      period: z.enum(["day","month"]).default("month"),
      hard_limit: z.number().nonnegative(),
      soft_limit: z.number().nonnegative().optional(),
      overage_behavior: z.enum(["allow","warn","block"]).default("warn"),
      billing_label: z.string().max(80).optional(),
    }).parse(req.body);
    await q(
      `insert into public.workspace_quotas (workspace_id, metric, period, hard_limit, soft_limit, overage_behavior, billing_label, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,now())
       on conflict (workspace_id, metric, period)
       do update set hard_limit=excluded.hard_limit, soft_limit=excluded.soft_limit,
                     overage_behavior=excluded.overage_behavior, billing_label=excluded.billing_label,
                     updated_at=now()`,
      [ws, b.metric, b.period, b.hard_limit, b.soft_limit ?? null, b.overage_behavior, b.billing_label ?? null]);
    return { ok: true };
  });
};

