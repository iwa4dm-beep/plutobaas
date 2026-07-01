import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";

const adminPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  app.addHook("preHandler", async (req, reply) => { requireServiceRole(req, reply); });

  app.get("/users", async () => {
    return db.selectFrom("users")
      .select(["id", "email", "role", "email_verified", "created_at"])
      .orderBy("created_at", "desc").execute();
  });

  app.patch("/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(["admin", "user"]).optional(), email_verified: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await db.updateTable("users").set(body.data).where("id", "=", id).execute();
    return { ok: true };
  });

  app.delete("/users/:id", async (req) => {
    const { id } = req.params as { id: string };
    await db.deleteFrom("users").where("id", "=", id).execute();
    return { ok: true };
  });

  app.get("/tables", async () => {
    const { rows } = await adminPool.query(`
      select table_name,
             (select count(*) from information_schema.columns c
                where c.table_schema='public' and c.table_name=t.table_name) as columns
        from information_schema.tables t
       where table_schema='public' and table_type='BASE TABLE'
       order by table_name
    `);
    return rows;
  });

  app.get("/tables/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return reply.code(400).send({ error: "bad_name" });
    const cols = await adminPool.query(`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema='public' and table_name=$1
       order by ordinal_position
    `, [name]);
    return { columns: cols.rows };
  });

  app.post("/sql", async (req, reply) => {
    const body = z.object({ sql: z.string().min(1).max(50000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const client = await adminPool.connect();
    try {
      const res = await client.query(body.data.sql);
      const arr = Array.isArray(res) ? res : [res];
      return arr.map((r) => ({ rowCount: r.rowCount, rows: r.rows ?? [], command: r.command }));
    } catch (e) {
      return reply.code(400).send({ error: "sql_error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      client.release();
    }
  });

  app.get("/logs", async (req) => {
    const q = (req.query ?? {}) as { source?: string; level?: string; limit?: string };
    let query = db.selectFrom("api_logs").selectAll();
    if (q.source) query = query.where("source", "=", q.source as never);
    if (q.level) query = query.where("level", "=", q.level as never);
    return query.orderBy("ts", "desc").limit(Math.min(500, Number(q.limit ?? 100))).execute();
  });

  app.get("/stats", async () => {
    const [{ users }] = await adminPool.query<{ users: string }>("select count(*)::text as users from public.users").then((r) => r.rows) as { users: string }[];
    const { rows: bkt } = await adminPool.query("select count(*)::text as buckets from public.buckets");
    const { rows: obj } = await adminPool.query("select count(*)::text as objects, coalesce(sum(size),0)::text as bytes from public.objects");
    return {
      users: Number(users),
      buckets: Number(bkt[0].buckets),
      objects: Number(obj[0].objects),
      storage_bytes: Number(obj[0].bytes),
    };
  });

  // Audit trail — read-only. Server-side filter by action (prefix with
  // '*' → LIKE), actor (email substring, ILIKE), status, free-text (q,
  // matches action / target / actor_email). Newest first. Response
  // includes `total` so the client can paginate.
  app.get("/audit", async (req, reply) => {
    const q = z.object({
      action:  z.string().max(120).optional(),
      actor:   z.string().max(200).optional(),
      status:  z.enum(["ok", "error", "dry_run"]).optional(),
      q:       z.string().max(200).optional(),
      since:   z.string().datetime().optional(),
      until:   z.string().datetime().optional(),
      limit:   z.coerce.number().int().min(1).max(200).default(50),
      offset:  z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query", issues: q.error.issues });
    const { action, actor, status, q: text, since, until, limit, offset } = q.data;

    const parts: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, val: unknown) => { args.push(val); parts.push(sql.replace("$?", `$${args.length}`)); };
    if (action) add(action.endsWith("*") ? "action like $?" : "action = $?", action.endsWith("*") ? action.replace(/\*$/, "%") : action);
    if (actor)  add("actor_email ilike $?", `%${actor}%`);
    if (status) add("status = $?", status);
    if (since)  add("ts >= $?", since);
    if (until)  add("ts <= $?", until);
    if (text) {
      args.push(`%${text}%`);
      const i = args.length;
      parts.push(`(action ilike $${i} or coalesce(target,'') ilike $${i} or coalesce(actor_email,'') ilike $${i})`);
    }
    const where = parts.length ? `where ${parts.join(" and ")}` : "";

    const [rows, count] = await Promise.all([
      adminPool.query(
        `select id, ts, actor_id, actor_email, actor_role, action, target, status, metadata, ip
           from public.audit_events ${where}
          order by ts desc
          limit ${limit} offset ${offset}`,
        args
      ),
      adminPool.query<{ n: string }>(
        `select count(*)::text as n from public.audit_events ${where}`,
        args
      ),
    ]);
    return {
      items: rows.rows,
      total: Number(count.rows[0]?.n ?? 0),
      limit, offset,
      next_offset: rows.rows.length === limit ? offset + limit : null,
    };
  });
}
