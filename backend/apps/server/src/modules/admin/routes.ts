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
}
