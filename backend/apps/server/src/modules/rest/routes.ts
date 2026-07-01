// PostgREST-style auto REST for tables in the `public` schema.
//
// Filters (PostgREST-compatible subset):
//   ?col=eq.x   ?col=neq.x   ?col=gt.5  ?col=gte.5  ?col=lt.5  ?col=lte.5
//   ?col=like.foo%25   ?col=ilike.foo%25   ?col=is.null   ?col=in.(a,b,c)
// Modifiers:
//   ?select=col1,col2   ?order=col.asc|desc[,col2.desc]
//   ?limit=20   ?offset=0
//
// RLS: before running the query we open a transaction and
// `SET LOCAL pluto.user_id = '<uuid>'` so `current_user_id()` returns the
// authenticated user's id inside RLS policies. Service-role requests skip
// the GUC and are executed as the pool user (RLS bypass by convention:
// grant BYPASSRLS to that role in production, or use a separate role).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import { env } from "../../config.js";
import { requireApiKey } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED = new Set(["select", "order", "limit", "offset", "apikey"]);
const OPS: Record<string, string> = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  like: "like", ilike: "ilike",
};

function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new HttpError(400, `invalid_identifier:${name}`);
  return name;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Filter = { col: string; op: string; value: unknown };

function parseFilters(query: Record<string, unknown>): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    if (typeof raw !== "string") continue;
    const idx = raw.indexOf(".");
    if (idx < 0) throw new HttpError(400, `bad_filter:${key}`);
    const op = raw.slice(0, idx);
    const val = raw.slice(idx + 1);
    assertIdent(key);
    if (op === "is") {
      if (val !== "null" && val !== "not.null") throw new HttpError(400, "bad_is");
      filters.push({ col: key, op: "is", value: val });
    } else if (op === "in") {
      const m = /^\((.*)\)$/.exec(val);
      if (!m) throw new HttpError(400, "bad_in");
      filters.push({ col: key, op: "in", value: m[1].split(",") });
    } else if (OPS[op]) {
      filters.push({ col: key, op, value: val });
    } else {
      throw new HttpError(400, `unknown_op:${op}`);
    }
  }
  return filters;
}

function buildWhere(filters: Filter[], startIdx: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  for (const f of filters) {
    const col = `"${f.col}"`;
    if (f.op === "is") {
      parts.push(`${col} is ${f.value === "null" ? "null" : "not null"}`);
    } else if (f.op === "in") {
      const arr = f.value as string[];
      const placeholders = arr.map(() => `$${i++}`).join(",");
      params.push(...arr);
      parts.push(`${col} in (${placeholders})`);
    } else {
      parts.push(`${col} ${OPS[f.op]} $${i++}`);
      params.push(f.value);
    }
  }
  return { sql: parts.length ? `where ${parts.join(" and ")}` : "", params };
}

function parseSelect(q: Record<string, unknown>): string {
  const s = typeof q.select === "string" ? q.select : "*";
  if (s === "*") return "*";
  return s.split(",").map((c) => `"${assertIdent(c.trim())}"`).join(",");
}

function parseOrder(q: Record<string, unknown>): string {
  const s = typeof q.order === "string" ? q.order : "";
  if (!s) return "";
  const parts = s.split(",").map((chunk) => {
    const [col, dir = "asc"] = chunk.split(".");
    assertIdent(col);
    if (dir !== "asc" && dir !== "desc") throw new HttpError(400, "bad_order_dir");
    return `"${col}" ${dir}`;
  });
  return `order by ${parts.join(",")}`;
}

async function withTx<T>(req: FastifyRequest, run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (req.auth?.apiKey !== "service_role" && req.auth?.user) {
      await client.query("select set_config('pluto.user_id', $1, true)", [req.auth.user.sub]);
    }
    const out = await run(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function handleError(reply: FastifyReply, e: unknown) {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
  const msg = e instanceof Error ? e.message : "internal_error";
  const pgCode = (e as { code?: string }).code;
  if (pgCode === "42501") return reply.code(403).send({ error: "rls_denied", message: msg });
  if (pgCode === "42P01") return reply.code(404).send({ error: "table_not_found" });
  if (pgCode === "23505") return reply.code(409).send({ error: "unique_violation", message: msg });
  return reply.code(500).send({ error: "db_error", message: msg });
}

export async function restRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.get("/:table", async (req, reply) => {
    try {
      const table = assertIdent((req.params as { table: string }).table);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const filters = parseFilters(q);
      const select = parseSelect(q);
      const order = parseOrder(q);
      const limit = Math.min(1000, Number(q.limit ?? 100));
      const offset = Number(q.offset ?? 0);
      const where = buildWhere(filters, 1);
      const sql = `select ${select} from public."${table}" ${where.sql} ${order} limit ${limit} offset ${offset}`;
      const result = await withTx(req, (c) => c.query(sql, where.params));
      return result.rows;
    } catch (e) { return handleError(reply, e); }
  });

  app.post("/:table", async (req, reply) => {
    try {
      const table = assertIdent((req.params as { table: string }).table);
      const body = req.body;
      const rows = Array.isArray(body) ? body : [body];
      if (rows.length === 0) return reply.code(400).send({ error: "empty_body" });
      const cols = Object.keys(rows[0] as object).map(assertIdent);
      const params: unknown[] = [];
      const tuples = rows.map((r) => {
        const vals = cols.map((c) => {
          params.push((r as Record<string, unknown>)[c]);
          return `$${params.length}`;
        });
        return `(${vals.join(",")})`;
      });
      const sql = `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(",")}) values ${tuples.join(",")} returning *`;
      const result = await withTx(req, (c) => c.query(sql, params));
      await log("rest", "info", `insert ${table} x${result.rowCount}`, req.auth?.user?.sub ?? null);
      return reply.code(201).send(result.rows);
    } catch (e) { return handleError(reply, e); }
  });

  app.patch("/:table", async (req, reply) => {
    try {
      const table = assertIdent((req.params as { table: string }).table);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const filters = parseFilters(q);
      if (filters.length === 0) return reply.code(400).send({ error: "patch_requires_filter" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cols = Object.keys(body).map(assertIdent);
      if (cols.length === 0) return reply.code(400).send({ error: "empty_body" });
      const params: unknown[] = [];
      const sets = cols.map((c) => { params.push(body[c]); return `"${c}" = $${params.length}`; }).join(",");
      const where = buildWhere(filters, params.length + 1);
      const sql = `update public."${table}" set ${sets} ${where.sql} returning *`;
      const result = await withTx(req, (c) => c.query(sql, [...params, ...where.params]));
      return result.rows;
    } catch (e) { return handleError(reply, e); }
  });

  app.delete("/:table", async (req, reply) => {
    try {
      const table = assertIdent((req.params as { table: string }).table);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const filters = parseFilters(q);
      if (filters.length === 0) return reply.code(400).send({ error: "delete_requires_filter" });
      const where = buildWhere(filters, 1);
      const sql = `delete from public."${table}" ${where.sql}`;
      const result = await withTx(req, (c) => c.query(sql, where.params));
      return reply.code(200).send({ deleted: result.rowCount });
    } catch (e) { return handleError(reply, e); }
  });
}
