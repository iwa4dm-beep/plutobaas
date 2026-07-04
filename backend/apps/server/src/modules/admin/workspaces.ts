// Workspaces module — CRUD + per-workspace API key management.
//
// Multi-tenant isolation is enforced two ways:
//   1. RLS policies scope reads/writes to `pluto.workspace_id` (set by
//      the API-key resolver in lib/apikey.ts).
//   2. Every request is served by a Postgres session that sets both
//      `pluto.user_id` and `pluto.workspace_id` before executing SQL.
//
// This file exposes the admin surface used by the dashboard to create
// tenants, invite members, and mint / revoke keys. Every mutation is
// guarded by requireAdmin (service-role key + admin JWT).

import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import pg from "pg";
import { env } from "../../config.js";
import { requireApiKey, requireAdmin, bustKeyCache } from "../../lib/apikey.js";
import { logAudit } from "../../lib/audit.js";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });

function sha256(v: string): string { return createHash("sha256").update(v).digest("hex"); }
function mintPlaintext(kind: "anon" | "service_role"): string {
  const prefix = kind === "anon" ? "pk_anon" : "sk_service";
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export async function workspacesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  app.addHook("preHandler", async (req, reply) => { requireAdmin(req, reply); });

  // List workspaces (admins see all; env-root sees all by definition).
  app.get("/", async () => {
    const { rows } = await pool.query(`
      select w.id, w.slug, w.name, w.created_at, w.archived_at,
             (select count(*) from public.workspace_members m where m.workspace_id = w.id) as member_count,
             (select count(*) from public.workspace_api_keys k
                where k.workspace_id = w.id and k.revoked_at is null) as active_keys
        from public.workspaces w
       order by w.created_at asc
    `);
    return { workspaces: rows };
  });

  // Create a workspace + seed initial anon/service_role keys atomically.
  app.post("/", async (req, reply) => {
    const body = z.object({
      slug: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
      name: z.string().min(1).max(120),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const anon = mintPlaintext("anon");
    const service = mintPlaintext("service_role");
    const actorId = req.auth!.user!.sub;

    const client = await pool.connect();
    try {
      await client.query("begin");
      const ws = await client.query<{ id: string }>(
        "insert into public.workspaces (slug, name, created_by) values ($1,$2,$3) returning id",
        [body.data.slug, body.data.name, actorId]
      );
      const wsId = ws.rows[0].id;
      await client.query(
        "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')",
        [wsId, actorId]
      );
      for (const [kind, plaintext] of [["anon", anon], ["service_role", service]] as const) {
        await client.query(
          `insert into public.workspace_api_keys
             (workspace_id, kind, name, key_prefix, key_hash, created_by)
           values ($1,$2,$3,$4,$5,$6)`,
          [wsId, kind, `default ${kind}`, plaintext.slice(0, 12), sha256(plaintext), actorId]
        );
      }
      await client.query("commit");
      bustKeyCache();

      await logAudit(req, {
        action: "workspace.create",
        target: body.data.slug,
        status: "ok",
        metadata: { workspace_id: wsId },
      });
      // Plaintext keys returned ONCE — the client must store them now.
      return { id: wsId, slug: body.data.slug, name: body.data.name, keys: { anon, service_role: service } };
    } catch (e) {
      await client.query("rollback");
      const message = e instanceof Error ? e.message : String(e);
      await logAudit(req, { action: "workspace.create", target: body.data.slug, status: "error", metadata: { message } });
      return reply.code(400).send({ error: "create_failed", message });
    } finally {
      client.release();
    }
  });

  // List a workspace's API keys (metadata only — hashes never leave the DB).
  app.get("/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad_id" });
    const { rows } = await pool.query(
      `select id, kind, name, key_prefix, created_at, revoked_at, last_used_at, use_count
         from public.workspace_api_keys
        where workspace_id = $1
        order by created_at desc`,
      [id]
    );
    return { keys: rows };
  });

  // Mint a fresh key. Plaintext is returned once.
  app.post("/:id/keys", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      kind: z.enum(["anon", "service_role"]),
      name: z.string().min(1).max(120).default("api key"),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const plaintext = mintPlaintext(body.data.kind);
    const row = await pool.query<{ id: string }>(
      `insert into public.workspace_api_keys
         (workspace_id, kind, name, key_prefix, key_hash, created_by)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [id, body.data.kind, body.data.name, plaintext.slice(0, 12), sha256(plaintext), req.auth!.user!.sub]
    );
    bustKeyCache();
    await logAudit(req, {
      action: "workspace.key.mint",
      target: row.rows[0].id,
      status: "ok",
      metadata: { workspace_id: id, kind: body.data.kind, name: body.data.name },
    });
    return { id: row.rows[0].id, kind: body.data.kind, plaintext };
  });

  app.post("/:id/keys/:keyId/revoke", async (req, reply) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    const r = await pool.query(
      "update public.workspace_api_keys set revoked_at = now() where id = $1 and workspace_id = $2 and revoked_at is null",
      [keyId, id]
    );
    if (!r.rowCount) return reply.code(404).send({ error: "not_found_or_already_revoked" });
    bustKeyCache();
    await logAudit(req, { action: "workspace.key.revoke", target: keyId, status: "ok", metadata: { workspace_id: id } });
    return { ok: true };
  });

  // Members
  app.get("/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `select m.user_id, m.role, m.created_at, u.email
         from public.workspace_members m
         join public.users u on u.id = m.user_id
        where m.workspace_id = $1
        order by m.created_at asc`,
      [id]
    );
    return { members: rows };
  });

  // Invite a member by email (dashboard contract) OR by user_id.
  // If the email is unknown we create a stub user row with a null
  // password_hash so the invite can be accepted later. Returns the
  // resolved user_id + role so the dashboard can refresh in place.
  app.post("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      email:   z.string().email().max(255).optional(),
      user_id: z.string().uuid().optional(),
      role:    z.enum(["owner", "admin", "developer", "viewer"]).default("developer"),
    }).refine((v) => v.email || v.user_id, { message: "email_or_user_id_required" })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    let userId = body.data.user_id;
    if (!userId && body.data.email) {
      const email = body.data.email.toLowerCase();
      const existing = await pool.query<{ id: string }>(
        "select id from public.users where email = $1", [email]);
      if (existing.rows[0]) userId = existing.rows[0].id;
      else {
        // Stub row — password_hash is null so /auth/sign-in refuses it
        // until the invited user completes password setup via /auth/recover.
        const created = await pool.query<{ id: string }>(
          `insert into public.users (email, password_hash, role, email_verified)
           values ($1, null, 'user', false)
           on conflict (email) do update set email = excluded.email
           returning id`, [email]);
        userId = created.rows[0].id;
      }
    }

    await pool.query(
      `insert into public.workspace_members (workspace_id, user_id, role, invited_by)
       values ($1,$2,$3,$4)
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
      [id, userId, body.data.role, req.auth!.user!.sub]
    );
    await logAudit(req, {
      action: "workspace.member.add",
      target: userId!,
      status: "ok",
      metadata: { workspace_id: id, role: body.data.role },
    });
    return { ok: true, user_id: userId, role: body.data.role };
  });

  // Role change from the RBAC dashboard. Owners cannot be demoted here —
  // the last remaining owner would be locked out.
  app.patch("/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = z.object({
      role: z.enum(["owner", "admin", "developer", "viewer"]),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const current = await pool.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id=$1 and user_id=$2",
      [id, userId]);
    if (!current.rows[0]) return reply.code(404).send({ error: "not_found" });

    if (current.rows[0].role === "owner" && body.data.role !== "owner") {
      const others = await pool.query<{ n: string }>(
        "select count(*)::text as n from public.workspace_members where workspace_id=$1 and role='owner' and user_id<>$2",
        [id, userId]);
      if (Number(others.rows[0].n) === 0) {
        return reply.code(409).send({ error: "last_owner_protected" });
      }
    }

    await pool.query(
      "update public.workspace_members set role=$1 where workspace_id=$2 and user_id=$3",
      [body.data.role, id, userId]);
    await logAudit(req, {
      action: "workspace.member.role_change",
      target: userId,
      status: "ok",
      metadata: { workspace_id: id, from: current.rows[0].role, to: body.data.role },
    });
    return { ok: true, user_id: userId, role: body.data.role };
  });

  app.delete("/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const cur = await pool.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id=$1 and user_id=$2",
      [id, userId]);
    if (!cur.rows[0]) return reply.code(404).send({ error: "not_found" });
    if (cur.rows[0].role === "owner") {
      const others = await pool.query<{ n: string }>(
        "select count(*)::text as n from public.workspace_members where workspace_id=$1 and role='owner' and user_id<>$2",
        [id, userId]);
      if (Number(others.rows[0].n) === 0) {
        return reply.code(409).send({ error: "last_owner_protected" });
      }
    }
    const r = await pool.query(
      "delete from public.workspace_members where workspace_id = $1 and user_id = $2",
      [id, userId]
    );
    if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
    await logAudit(req, { action: "workspace.member.remove", target: userId, status: "ok", metadata: { workspace_id: id } });
    return { ok: true };
  });

  // The role → capability matrix the RBAC dashboard renders. Sourced
  // from public.rbac_permissions so we do not duplicate the contract
  // in the frontend.
  app.get("/permissions", async () => {
    const { rows } = await pool.query<{ role: string; capability: string }>(
      "select role, capability from public.rbac_permissions order by role, capability");
    const roles: Record<string, string[]> = { owner: [], admin: [], developer: [], viewer: [] };
    for (const r of rows) (roles[r.role] ??= []).push(r.capability);
    return { roles };
  });
}
