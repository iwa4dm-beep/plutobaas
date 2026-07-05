import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken } from "../../lib/jwt.js";
import { requireApiKey } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";
import { preCheck, recordFailure, recordSuccess } from "../../lib/ratelimit.js";

function limited(reply: FastifyReply, retryAfterSec: number, reason: string) {
  reply.header("Retry-After", String(retryAfterSec));
  return reply.code(429).send({ error: "rate_limited", reason, retry_after_sec: retryAfterSec });
}
type Req = FastifyRequest;

const credsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

async function issueSession(user: { id: string; email: string; role: "admin" | "user" }) {
  const access_token = await signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refresh_token = randomBytes(32).toString("hex");
  const expires_at = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000);
  await db.insertInto("refresh_tokens").values({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: hashToken(refresh_token),
    expires_at,
    revoked_at: null,
  }).execute();
  return {
    access_token,
    refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + env.ACCESS_TOKEN_TTL_SEC,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post("/sign-up", async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { email, password } = parsed.data;

    const existing = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (existing) return reply.code(409).send({ error: "email_taken" });

    const password_hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
    const userCountRow = await db.selectFrom("users").select(db.fn.count<string>("id").as("c")).executeTakeFirst();
    const isFirst = !userCountRow || Number(userCountRow.c) === 0;

    const id = crypto.randomUUID();
    const user = { id, email, role: (isFirst ? "admin" : "user") as "admin" | "user" };
    await db.insertInto("users").values({
      id,
      email,
      password_hash,
      role: user.role,
      email_verified: false,
      created_at: new Date(),
    }).execute();

    const session = await issueSession(user);
    await log("auth", "info", `sign-up ${email}`, id);
    return { user: { ...user, email_verified: false }, session };
  });

  app.post("/sign-in", async (req: Req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { email, password } = parsed.data;

    // Brute-force gate: per-IP + per-email sliding windows w/ lockout.
    const gate = preCheck(req, "sign_in", email);
    if (!gate.ok) {
      await recordFailure(req, "sign_in", email, "rate_limited");
      return limited(reply, gate.retryAfterSec, gate.reason);
    }

    const row = await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
    if (!row) {
      await recordFailure(req, "sign_in", email, "bad_credentials");
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await argon2.verify(row.password_hash, password);
    if (!ok) {
      await recordFailure(req, "sign_in", email, "bad_credentials");
      await log("auth", "warn", `failed sign-in ${email}`);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await recordSuccess(req, "sign_in", email);
    const session = await issueSession({ id: row.id, email: row.email, role: row.role });
    await log("auth", "info", `sign-in ${email}`, row.id);
    return {
      user: { id: row.id, email: row.email, role: row.role, email_verified: row.email_verified },
      session,
    };
  });

  app.post("/refresh", async (req: Req, reply) => {
    const body = z.object({ refresh_token: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const hashed = hashToken(body.data.refresh_token);

    // Rate-limit by IP + by token hash (which is stable across retries
    // of the same stolen token — attacker can't spray many IPs to bypass).
    const gate = preCheck(req, "refresh", hashed);
    if (!gate.ok) {
      await recordFailure(req, "refresh", hashed, "rate_limited");
      return limited(reply, gate.retryAfterSec, gate.reason);
    }

    const row = await db.selectFrom("refresh_tokens")
      .selectAll()
      .where("token_hash", "=", hashed)
      .executeTakeFirst();
    if (!row || row.revoked_at || row.expires_at < new Date()) {
      await recordFailure(req, "refresh", hashed, "invalid_token");
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const user = await db.selectFrom("users").selectAll().where("id", "=", row.user_id).executeTakeFirst();
    if (!user) {
      await recordFailure(req, "refresh", hashed, "invalid_token");
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    // rotate — a rotated token that's later replayed hits the revoked_at
    // branch above and increments the failure counter.
    await db.updateTable("refresh_tokens").set({ revoked_at: new Date() }).where("id", "=", row.id).execute();
    await recordSuccess(req, "refresh", hashed);
    const session = await issueSession({ id: user.id, email: user.email, role: user.role });
    return { session };
  });

  app.post("/sign-out", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    await db.updateTable("refresh_tokens")
      .set({ revoked_at: new Date() })
      .where("user_id", "=", req.auth.user.sub)
      .where("revoked_at", "is", null)
      .execute();
    return { ok: true };
  });

  app.get("/user", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    const row = await db.selectFrom("users")
      .select(["id", "email", "role", "email_verified", "created_at"])
      .where("id", "=", req.auth.user.sub)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { user: row };
  });

  // ---- Magic link (passwordless email sign-in) ---------------------------
  const magicSchema = z.object({
    email: z.string().email().max(255),
    redirect_to: z.string().url().max(500).optional(),
  });
  app.post("/magiclink/send", async (req, reply) => {
    const gate = preCheck(req, "magiclink", (req.body as { email?: string })?.email ?? "");
    if (!gate.ok) return limited(reply, gate.retryAfterSec, gate.reason);
    const parsed = magicSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const token = randomBytes(24).toString("base64url");
    const token_hash = hashToken(token);
    const expires_at = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    await db.insertInto("email_magic_links" as never).values({
      id: crypto.randomUUID(),
      email: parsed.data.email.toLowerCase(),
      token_hash,
      redirect_to: parsed.data.redirect_to ?? null,
      expires_at,
    } as never).execute();
    await log("auth", "info", `magiclink sent ${parsed.data.email}`, null);
    // Token surfaced only in non-production so the smoke tests / dashboard
    // can exercise the flow without an SMTP round-trip. In production the
    // link is delivered via the comms module.
    const debug = process.env.NODE_ENV !== "production" ? { token } : {};
    await recordSuccess(req, "magiclink", parsed.data.email);
    return { ok: true, ttl_sec: 900, ...debug };
  });

  app.post("/magiclink/verify", async (req, reply) => {
    const parsed = z.object({ token: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const token_hash = hashToken(parsed.data.token);
    const row = await db.selectFrom("email_magic_links" as never)
      .select(["id", "email", "expires_at", "consumed_at"] as never)
      .where("token_hash" as never, "=", token_hash)
      .executeTakeFirst() as { id: string; email: string; expires_at: Date; consumed_at: Date | null } | undefined;
    if (!row) return reply.code(400).send({ error: "invalid_token" });
    if (row.consumed_at) return reply.code(400).send({ error: "token_used" });
    if (new Date(row.expires_at).getTime() < Date.now())
      return reply.code(400).send({ error: "token_expired" });

    // Upsert the user (magic link doubles as sign-up).
    let user = await db.selectFrom("users").selectAll()
      .where("email", "=", row.email).executeTakeFirst();
    if (!user) {
      const id = crypto.randomUUID();
      await db.insertInto("users").values({
        id, email: row.email,
        password_hash: "", role: "user",
        email_verified: true, created_at: new Date(),
      }).execute();
      user = { id, email: row.email, password_hash: "", role: "user",
               email_verified: true, created_at: new Date() } as never;
    }
    await db.updateTable("email_magic_links" as never)
      .set({ consumed_at: new Date() } as never)
      .where("id" as never, "=", row.id)
      .execute();
    const session = await issueSession({ id: user!.id, email: user!.email, role: user!.role as "admin" | "user" });
    await log("auth", "info", `magiclink verified ${row.email}`, user!.id);
    return { user: { id: user!.id, email: user!.email, role: user!.role, email_verified: true }, session };
  });
}

