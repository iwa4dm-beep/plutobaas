import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { requireApiKey, requireAdmin, bustKeyCache } from "../../lib/apikey.js";
import { audit as logAudit } from "../../lib/audit.js";

const adminPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  // Every /admin/v1/* endpoint requires BOTH the service_role key AND
  // an admin JWT. A leaked API key alone cannot mutate anything.
  app.addHook("preHandler", async (req, reply) => { requireAdmin(req, reply); });

  // Blanket audit hook: every admin request (GET included) is recorded
  // so that read access to sensitive endpoints (users list, audit trail,
  // key list, settings) is traceable, not just the mutations. Handler-
  // level `logAudit(...)` calls layer richer metadata on top.
  app.addHook("onResponse", async (req, reply) => {
    // Skip when auth failed — requireAdmin already returned 401/403 and
    // we don't want to spam audit_events with rejected preflights.
    if (!req.auth || reply.statusCode >= 400 && reply.statusCode < 500 && !req.auth.user) return;
    const method = req.method.toLowerCase();
    if (method === "options" || method === "head") return;
    await logAudit(req, {
      action: `admin.${method}`,
      target: req.routeOptions?.url ?? req.url,
      status: reply.statusCode >= 400 ? "error" : "ok",
      metadata: {
        method: req.method,
        path: req.url,
        status: reply.statusCode,
        workspace_id: req.auth.workspaceId,
        response_ms: reply.elapsedTime ? Math.round(reply.elapsedTime) : undefined,
      },
    });
  });



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

  // ============================================================
  // API keys — list / mint / revoke (per-workspace)
  //
  // Mint returns the plaintext EXACTLY ONCE. We only ever store
  // sha256(plaintext) so a compromised DB dump cannot be replayed.
  // ============================================================
  app.get("/workspaces/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad_workspace_id" });
    const { rows } = await adminPool.query(
      `select id, kind, name, key_prefix, created_at, revoked_at, last_used_at, use_count
         from public.workspace_api_keys where workspace_id = $1 order by created_at desc`,
      [id],
    );
    return { items: rows };
  });

  app.post("/workspaces/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().min(1).max(80),
      kind: z.enum(["anon", "service_role"]),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.success });

    // 32 random bytes → 43-char base64url. Prefix identifies the key
    // kind at a glance in logs without revealing entropy.
    const secret = randomBytes(32).toString("base64url");
    const plaintext = `pk_${body.data.kind === "service_role" ? "svc" : "anon"}_${secret}`;
    const prefix = plaintext.slice(0, 12);
    const keyId = crypto.randomUUID();

    await adminPool.query(
      `insert into public.workspace_api_keys
         (id, workspace_id, kind, name, key_prefix, key_hash, created_by)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [keyId, id, body.data.kind, body.data.name, prefix, sha256(plaintext), req.auth?.user?.sub ?? null],
    );
    await logAudit(req, {
      action: "api_key.mint", target: keyId, status: "ok",
      metadata: { workspace_id: id, kind: body.data.kind, name: body.data.name, prefix },
    });
    return reply.code(201).send({
      id: keyId, kind: body.data.kind, name: body.data.name, key_prefix: prefix,
      // ⚠️ shown once — the client must persist it now.
      plaintext,
    });
  });

  app.delete("/workspaces/:id/keys/:keyId", async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    const r = await adminPool.query(
      `update public.workspace_api_keys set revoked_at = now(), status = 'revoked'
        where id = $1 and workspace_id = $2 and revoked_at is null
       returning id`,
      [keyId, id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found_or_already_revoked" });
    bustKeyCache();
    await logAudit(req, { action: "api_key.revoke", target: keyId, status: "ok", metadata: { workspace_id: id } });
    return { ok: true };
  });

  // ============================================================
  // Service settings — key/value store scoped to a workspace
  // ============================================================
  const settingsRow = z.object({
    key:       z.string().min(1).max(120).regex(/^[a-z0-9_.-]+$/i),
    value:     z.unknown(),
    is_secret: z.boolean().optional().default(false),
  });

  app.get("/settings", async (req) => {
    const q = (req.query ?? {}) as { workspace_id?: string };
    const wsId = q.workspace_id ?? req.auth?.workspaceId ?? null;
    if (!wsId) return { items: [] };
    const { rows } = await adminPool.query(
      `select key, value, is_secret, updated_at from public.service_settings
        where workspace_id = $1 order by key`,
      [wsId],
    );
    // Redact secrets on read; the dashboard shows "•••••" and offers
    // a "reveal" action that goes through a separate audited endpoint.
    return {
      items: rows.map((r) => ({ ...r, value: r.is_secret ? null : r.value })),
    };
  });

  app.put("/settings", async (req, reply) => {
    const body = settingsRow.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    const wsId = (req.body as { workspace_id?: string }).workspace_id ?? req.auth?.workspaceId;
    if (!wsId) return reply.code(400).send({ error: "workspace_required" });

    await adminPool.query(
      `insert into public.service_settings (workspace_id, key, value, is_secret, updated_by, updated_at)
       values ($1,$2,$3::jsonb,$4,$5, now())
       on conflict (workspace_id, key) do update set
         value = excluded.value, is_secret = excluded.is_secret,
         updated_by = excluded.updated_by, updated_at = now()`,
      [wsId, body.data.key, JSON.stringify(body.data.value ?? null), body.data.is_secret, req.auth?.user?.sub ?? null],
    );
    await logAudit(req, {
      action: "settings.upsert", target: body.data.key, status: "ok",
      metadata: { workspace_id: wsId, is_secret: body.data.is_secret },
    });
    return { ok: true };
  });

  app.delete("/settings/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const wsId = (req.query as { workspace_id?: string })?.workspace_id ?? req.auth?.workspaceId;
    if (!wsId) return reply.code(400).send({ error: "workspace_required" });
    await adminPool.query(`delete from public.service_settings where workspace_id = $1 and key = $2`, [wsId, key]);
    await logAudit(req, { action: "settings.delete", target: key, status: "ok", metadata: { workspace_id: wsId } });
    return { ok: true };
  });

  // ============================================================
  // API key ROTATION w/ grace period
  //
  // POST /workspaces/:id/keys/:keyId/rotate { grace_seconds?: number }
  //   → mints a NEW key of the same kind, links it via rotated_from_id,
  //     marks the OLD key as `status = 'rotating'` with a
  //     `grace_expires_at` in the future. During the grace window,
  //     apikey.ts accepts BOTH keys so clients can swap credentials
  //     without downtime. When the window elapses the old key stops
  //     resolving on the next request (cache bust below is immediate;
  //     natural expiry is enforced by resolveKey()).
  //
  // POST /workspaces/:id/keys/:keyId/finalize
  //   → immediately revokes the predecessor of a rotation, ending
  //     the grace window early.
  // ============================================================
  app.post("/workspaces/:id/keys/:keyId/rotate", async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    const body = z.object({
      grace_seconds: z.number().int().min(0).max(7 * 86400).optional().default(86400),
      name:          z.string().min(1).max(80).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const src = await client.query<{ id: string; kind: "anon" | "service_role"; name: string; status: string }>(
        `select id, kind, name, status from public.workspace_api_keys
          where id = $1 and workspace_id = $2 for update`,
        [keyId, id],
      );
      if (src.rowCount === 0) { await client.query("rollback"); return reply.code(404).send({ error: "not_found" }); }
      if (src.rows[0].status !== "active") {
        await client.query("rollback");
        return reply.code(409).send({ error: "not_rotatable", status: src.rows[0].status });
      }
      const kind = src.rows[0].kind;
      const secret = randomBytes(32).toString("base64url");
      const plaintext = `pk_${kind === "service_role" ? "svc" : "anon"}_${secret}`;
      const prefix    = plaintext.slice(0, 12);
      const newId     = crypto.randomUUID();
      const grace     = new Date(Date.now() + body.data.grace_seconds * 1000);

      await client.query(
        `insert into public.workspace_api_keys
           (id, workspace_id, kind, name, key_prefix, key_hash, created_by, status, rotated_from_id)
         values ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
        [newId, id, kind, body.data.name ?? `${src.rows[0].name} (rotated)`, prefix,
         sha256(plaintext), req.auth?.user?.sub ?? null, keyId],
      );
      await client.query(
        `update public.workspace_api_keys
            set status = 'rotating', grace_expires_at = $1, rotated_to_id = $2
          where id = $3`,
        [grace, newId, keyId],
      );
      await client.query("commit");
      bustKeyCache();
      await logAudit(req, {
        action: "api_key.rotate", target: keyId, status: "ok",
        metadata: {
          workspace_id: id, kind, new_key_id: newId,
          grace_expires_at: grace.toISOString(),
          grace_seconds: body.data.grace_seconds,
        },
      });
      return reply.code(201).send({
        rotated_from: keyId,
        new_key: { id: newId, kind, name: body.data.name ?? `${src.rows[0].name} (rotated)`, key_prefix: prefix, plaintext },
        grace_expires_at: grace.toISOString(),
      });
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/workspaces/:id/keys/:keyId/finalize", async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    const r = await adminPool.query(
      `update public.workspace_api_keys
          set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
              grace_expires_at = now()
        where id = $1 and workspace_id = $2 and status = 'rotating'
       returning id`,
      [keyId, id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_rotating_or_not_found" });
    bustKeyCache();
    await logAudit(req, { action: "api_key.finalize_rotation", target: keyId, status: "ok", metadata: { workspace_id: id } });
    return { ok: true };
  });
}


