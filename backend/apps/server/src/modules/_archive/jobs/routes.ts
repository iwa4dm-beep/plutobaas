// Server-side job workflow.
//
// Motivation: some tasks (nightly reports, backfills, webhook consumers,
// cron) need to read/write across users and therefore must bypass RLS.
// Handing out the service_role key to those workers is dangerous — one
// leak and the attacker owns the database.
//
// Instead we mint short-lived **job tokens**. A token:
//   * is issued by an admin via the dashboard (service-role only)
//   * has a name, a scope (list of allowed job names), and a hard TTL
//   * is stored only as a sha256 hash
//   * is exchanged at run-time for a query connection that runs as the
//     dedicated `pluto_jobs` Postgres role (BYPASSRLS). The service-role
//     key never leaves the server.
//
// Endpoints:
//   POST   /jobs/v1/tokens            (service-role)  → { token }
//   GET    /jobs/v1/tokens            (service-role)  → list
//   DELETE /jobs/v1/tokens/:id        (service-role)
//   POST   /jobs/v1/exec              (job token)     → run SQL as pluto_jobs
//   POST   /jobs/v1/rpc/:job          (job token)     → call named job (scope-gated)

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { z } from "zod";
import { env } from "../../config.js";
import { db } from "../../db/index.js";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";
import { audit } from "../../lib/audit.js";
import { log } from "../../lib/logs.js";

// Dedicated low-privilege pool. Credentials come from env; if unset we
// fall back to the app DATABASE_URL for local dev, with a loud warning.
const JOBS_URL = process.env.JOBS_DATABASE_URL ?? env.DATABASE_URL;
if (!process.env.JOBS_DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("[pluto] JOBS_DATABASE_URL not set — using app DATABASE_URL for job pool");
}
const jobsPool = new pg.Pool({ connectionString: JOBS_URL, max: 4 });

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function loadTokenFromHeader(req: { headers: Record<string, unknown> }) {
  const hdr = (req.headers["x-job-token"] ?? req.headers["authorization"]) as string | undefined;
  if (!hdr) return null;
  const raw = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  const row = await db.selectFrom("job_tokens" as never).selectAll()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .where("token_hash" as any, "=", hash(raw))
    .executeTakeFirst() as unknown as {
      id: string; name: string; scope: string[]; expires_at: Date; revoked_at: Date | null;
    } | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function jobsRoutes(app: FastifyInstance) {
  // --- admin surface (strict: service role + active admin session) ---
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);
    scoped.addHook("preHandler", async (req, reply) => { requireAdmin(req, reply); });

    scoped.post("/tokens", async (req, reply) => {
      const body = z.object({
        name: z.string().min(1).max(80),
        scope: z.array(z.string().regex(/^[a-z0-9_.-]+$/)).max(32).default([]),
        ttl_seconds: z.number().int().min(60).max(60 * 60 * 24 * 90).default(60 * 60 * 24 * 7),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const plaintext = `pjt_${randomBytes(24).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + body.data.ttl_seconds * 1000);
      const inserted = await db.insertInto("job_tokens" as never).values({
        name: body.data.name,
        token_hash: hash(plaintext),
        scope: body.data.scope,
        created_by: req.auth?.user?.sub ?? null,
        expires_at: expiresAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any).returning(["id", "name", "expires_at"] as never).executeTakeFirst() as unknown as { id: string; name: string; expires_at: string };

      await log("admin", "warn", `minted job token ${body.data.name}`, req.auth?.user?.sub ?? null);
      await audit(req, {
        action: "job_token.mint",
        target: inserted?.id ?? null,
        metadata: { name: body.data.name, scope: body.data.scope, expires_at: inserted?.expires_at },
      });
      // Plaintext is shown ONCE — the dashboard must warn the operator.
      return { ...inserted, token: plaintext };
    });

    scoped.get("/tokens", async () => {
      const rows = await db.selectFrom("job_tokens" as never)
        .select(["id", "name", "scope", "created_at", "expires_at", "revoked_at", "last_used_at", "use_count"] as never)
        .execute();
      return rows;
    });

    scoped.delete("/tokens/:id", async (req) => {
      const { id } = req.params as { id: string };
      await db.updateTable("job_tokens" as never)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ revoked_at: new Date() } as any)
        .where("id" as never, "=", id as never).execute();
      await log("admin", "warn", `revoked job token ${id}`, req.auth?.user?.sub ?? null);
      await audit(req, { action: "job_token.revoke", target: id });
      return { ok: true };
    });
  });

  // --- worker surface (job token auth) ---

  app.post("/exec", async (req, reply) => {
    const token = await loadTokenFromHeader(req);
    if (!token) return reply.code(401).send({ error: "invalid_or_expired_token" });
    const body = z.object({
      sql: z.string().min(1).max(50_000),
      params: z.array(z.unknown()).max(64).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const client = await jobsPool.connect();
    try {
      // Statement timeout scoped to this connection only.
      await client.query("set local statement_timeout = '30s'");
      const res = await client.query(body.data.sql, body.data.params ?? []);
      await bumpUsage(token.id);
      return { rowCount: res.rowCount, rows: res.rows };
    } catch (e) {
      return reply.code(400).send({ error: "exec_failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      client.release();
    }
  });

  app.post("/rpc/:job", async (req, reply) => {
    const token = await loadTokenFromHeader(req);
    if (!token) return reply.code(401).send({ error: "invalid_or_expired_token" });
    const { job } = req.params as { job: string };
    if (!/^[a-z0-9_.-]+$/.test(job)) return reply.code(400).send({ error: "bad_job_name" });
    if (token.scope.length > 0 && !token.scope.includes(job)) {
      return reply.code(403).send({ error: "out_of_scope", scope: token.scope });
    }
    const client = await jobsPool.connect();
    try {
      await client.query("set local statement_timeout = '60s'");
      const args = (req.body as { args?: unknown[] } | null)?.args ?? [];
      const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
      const res = await client.query(
        `select public.${job}(${placeholders}) as result`,
        args as unknown[]
      );
      await bumpUsage(token.id);
      return { result: res.rows[0]?.result ?? null };
    } catch (e) {
      return reply.code(400).send({ error: "rpc_failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      client.release();
    }
  });
}

async function bumpUsage(id: string) {
  await db.updateTable("job_tokens" as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(({ eb }: any) => ({
      last_used_at: new Date(),
      use_count: eb("use_count", "+", 1),
    }))
    .where("id" as never, "=", id as never).execute()
    .catch(() => {});
}
